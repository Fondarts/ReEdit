"""Generate text mask + pre-blanked frames for VACE inpainting.

Supports THREE detection modes:
  - mode="boxes": paint filled rectangles from a list of normalised
                  bounding boxes (produced by Gemini's video analysis).
                  Bypasses every threshold heuristic — if the model
                  picked the right box, we get the right mask.
  - mode="luma":  bright text (white/near-white) via luma threshold
  - mode="color": colored text via HSV range match

For the luma/color modes we also apply:
  - ROI gating:      restrict the mask to a region of the frame (e.g.
                     the lower third) so bright skies / highlights /
                     specular reflections outside that region stop
                     creating false positives. Driven by the
                     `graphics.position` hint Gemini emits.
  - Temporal persistence gate: drop pixels that aren't lit in a high
                     enough fraction of frames. Kills backgrounds that
                     happen to clear the luma threshold on a panning
                     camera but never sit on the same (x, y).
  - Blob area cap:   drop connected components that cover more than X%
                     of the frame. On-screen text is always small.

The boxes mode intentionally skips every refinement step above: the
model has already decided what counts as a graphic. We just pad +
dilate + feather whatever it hands us.

Outputs:
  {basename}_mask.mp4   — binary mask (white = area to inpaint)
  {basename}_blank.mp4  — frames with masked region replaced by sampled bg color
"""
import cv2, numpy as np, argparse, os, json

def sample_bg_color(frame, mask):
    """Median color of pixels OUTSIDE the mask (true background).

    Uses all non-mask pixels to avoid bias when text covers frame borders.
    """
    non_mask = mask == 0
    if non_mask.sum() == 0:
        return (128, 128, 128)  # fallback gray if mask covers everything
    bg_pixels = frame[non_mask]
    return tuple(int(x) for x in np.median(bg_pixels, axis=0))


def build_roi_mask(roi, w, h, tol=0.10):
    """Return a uint8 mask (w, h) where 255 = allowed region for the graphic.

    `tol` expands each region by a fraction of its dimension so a slightly
    off position hint from Gemini ("bottom" when the real graphic sits
    at y=0.48) still includes the real pixels.
    """
    full = np.full((h, w), 255, dtype=np.uint8)
    if not roi or roi in ("full_frame", "scattered", "none", ""):
        return full
    rm = np.zeros((h, w), dtype=np.uint8)
    if roi == "top":
        rm[0:int(h * (0.5 + tol)), :] = 255
    elif roi == "bottom":
        rm[int(h * (0.5 - tol)):, :] = 255
    elif roi == "center":
        y0, y1 = int(h * (0.25 - tol)), int(h * (0.75 + tol))
        x0, x1 = int(w * (0.10 - tol)), int(w * (0.90 + tol))
        rm[max(0, y0):min(h, y1), max(0, x0):min(w, x1)] = 255
    elif roi == "lower_third":
        rm[int(h * (0.66 - tol)):, :] = 255
    elif roi == "upper_third":
        rm[:int(h * (0.33 + tol)), :] = 255
    elif roi == "corner_top_left":
        rm[:int(h * (0.5 + tol)), :int(w * (0.5 + tol))] = 255
    elif roi == "corner_top_right":
        rm[:int(h * (0.5 + tol)), int(w * (0.5 - tol)):] = 255
    elif roi == "corner_bottom_left":
        rm[int(h * (0.5 - tol)):, :int(w * (0.5 + tol))] = 255
    elif roi == "corner_bottom_right":
        rm[int(h * (0.5 - tol)):, int(w * (0.5 - tol)):] = 255
    else:
        # Unknown roi — fail open.
        return full
    return rm


def filter_large_blobs(mask, max_area_pct, w, h):
    """Drop connected components larger than max_area_pct of the frame.

    max_area_pct=None or <=0 disables the filter. Returns the filtered
    mask. Uses 8-connectivity which matches how `cv2.dilate` with a RECT
    kernel would grow a cluster, so the component labels here line up
    intuitively with how the text looks on screen.
    """
    if not max_area_pct or max_area_pct <= 0:
        return mask
    max_area = int(w * h * max_area_pct / 100.0)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros_like(mask)
    for i in range(1, num_labels):  # skip background (label 0)
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area <= max_area:
            keep[labels == i] = 255
    return keep


def raw_detection_mask(frame, mode, luma_threshold, hsv_lower, hsv_upper):
    """Return the per-frame binary detection mask (uint8 0/255) used as the
    starting point before ROI / persistence / area filters."""
    if mode == "luma":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, luma_threshold, 255, cv2.THRESH_BINARY)
        return mask
    if mode == "color":
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        return cv2.inRange(hsv, np.array(hsv_lower), np.array(hsv_upper))
    raise ValueError(f"Unknown mode: {mode}")


def build_boxes_mask(boxes, w, h,
                     padding_pct_x=7.0, padding_pct_y=10.0,
                     offset_pct_x=0.0, offset_pct_y=5.0):
    """Paint a static mask from a list of bounding boxes in Gemini's
    0-1000 normalised format.

    `boxes` is a list of dicts. Each dict must have `box_2d` as
    [ymin, xmin, ymax, xmax]. Coordinates are clamped to the frame.

    Padding expands each box symmetrically on both edges of its axis;
    offset shifts the whole box in one direction (positive Y = down,
    positive X = right). Offsets compensate for Gemini's systematic
    drift — the model's boxes sit consistently ABOVE the actual text
    on overlaid captions (probably because it anchors on the cap line,
    not the mean line). A small positive `offset_pct_y` nudges every
    painted rect down into the real text, which is cheaper than
    expanding the box on both ends (which swallows background above
    the graphic).

    Returns a uint8 (h, w) mask with 255 inside the painted rectangles.
    """
    mask = np.zeros((h, w), dtype=np.uint8)
    if not boxes:
        return mask
    pad_x = int(w * padding_pct_x / 100.0)
    pad_y = int(h * padding_pct_y / 100.0)
    off_x = int(w * offset_pct_x / 100.0)
    off_y = int(h * offset_pct_y / 100.0)
    painted = 0
    for b in boxes:
        bb = b.get("box_2d") if isinstance(b, dict) else b
        if not (isinstance(bb, (list, tuple)) and len(bb) == 4):
            continue
        try:
            ymin, xmin, ymax, xmax = [float(v) for v in bb]
        except (TypeError, ValueError):
            continue
        # Scale 0-1000 → pixel space. Clamp to frame, enforce ordering.
        # Offset is applied to both edges equally so the rect keeps its
        # size and just shifts; padding then widens both edges.
        y0 = max(0, int(round(min(ymin, ymax) / 1000.0 * h)) + off_y - pad_y)
        y1 = min(h, int(round(max(ymin, ymax) / 1000.0 * h)) + off_y + pad_y)
        x0 = max(0, int(round(min(xmin, xmax) / 1000.0 * w)) + off_x - pad_x)
        x1 = min(w, int(round(max(xmin, xmax) / 1000.0 * w)) + off_x + pad_x)
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = 255
            painted += 1
    print(f"Boxes mask: {painted}/{len(boxes)} rectangles painted (padding x={pad_x}px y={pad_y}px, offset x={off_x}px y={off_y}px).")
    return mask


def compute_persistence_mask(src, mode, luma_threshold, hsv_lower, hsv_upper,
                             roi_mask, persistence_threshold):
    """First pass: which pixels are "detected" in at least persistence_threshold
    fraction of frames.

    A real overlay (caption, logo, chyron) is locked to the same x/y across
    the shot, so the same pixels light up every frame. A sky / highlight /
    reflection moves with the camera and only hits a given pixel for a
    fraction of the shot — even if the per-frame threshold pass lights them
    up, they don't survive the temporal vote.

    Returns a uint8 mask (255 = persistent, 0 = transient) already gated by
    `roi_mask`, or `None` if persistence is disabled.
    """
    if persistence_threshold is None or persistence_threshold <= 0:
        return None
    cap = cv2.VideoCapture(src)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    accum = np.zeros((h, w), dtype=np.uint32)
    n_frames = 0
    roi_binary = (roi_mask > 0).astype(np.uint8) if roi_mask is not None else None
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        n_frames += 1
        m = raw_detection_mask(frame, mode, luma_threshold, hsv_lower, hsv_upper)
        # Only count detections inside the ROI — an ROI-gated persistence
        # is strictly tighter than a full-frame one.
        if roi_binary is not None:
            m = cv2.bitwise_and(m, roi_mask)
        accum += (m > 0).astype(np.uint32)
    cap.release()
    if n_frames == 0:
        return np.zeros((h, w), dtype=np.uint8)
    # Fractional persistence per pixel, compared against the threshold.
    frac = accum.astype(np.float32) / float(n_frames)
    persistent = (frac >= persistence_threshold).astype(np.uint8) * 255
    print(f"Persistence pass: {n_frames} frames analyzed, threshold={persistence_threshold:.2f}, persistent pixels={int((persistent > 0).sum())} ({(persistent > 0).mean() * 100:.2f}% of frame).")
    return persistent


def make_mask(src, dst_mask, dst_blank, mode="luma",
              luma_threshold=195,
              hsv_lower=(35, 120, 100), hsv_upper=(55, 255, 255),
              dilate_kernel=25, dilate_iter=2,
              roi=None, max_blob_area_pct=15.0,
              persistence_threshold=0.60,
              boxes=None, boxes_padding_pct_x=7.0, boxes_padding_pct_y=10.0,
              boxes_offset_pct_x=0.0, boxes_offset_pct_y=5.0):
    cap = cv2.VideoCapture(src)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    if mode == "boxes":
        print(f"Source: {w}x{h} @ {fps:.2f}fps, {n} frames, mode=boxes, boxes={len(boxes) if boxes else 0}, dilate_kernel={dilate_kernel}")
    else:
        print(f"Source: {w}x{h} @ {fps:.2f}fps, {n} frames, mode={mode}, roi={roi}, max_blob_area_pct={max_blob_area_pct}, persistence_threshold={persistence_threshold}")

    # === Mode: boxes ========================================================
    # Gemini provided per-graphic bounding boxes. Paint them as a single
    # static mask, dilate, and stamp that onto every frame. No thresholds,
    # no ROI, no persistence — the model has already decided what counts.
    if mode == "boxes":
        static_mask = build_boxes_mask(
            boxes or [], w, h,
            padding_pct_x=boxes_padding_pct_x, padding_pct_y=boxes_padding_pct_y,
            offset_pct_x=boxes_offset_pct_x, offset_pct_y=boxes_offset_pct_y,
        )
        if dilate_kernel and dilate_kernel > 0 and dilate_iter and dilate_iter > 0:
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (dilate_kernel, dilate_kernel))
            static_mask = cv2.dilate(static_mask, kernel, iterations=dilate_iter)

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out_mask = cv2.VideoWriter(dst_mask, fourcc, fps, (w, h), isColor=False)
        out_blank = cv2.VideoWriter(dst_blank, fourcc, fps, (w, h), isColor=True)

        bg_color = None
        coverages = []
        i = 0
        mask_3ch = cv2.cvtColor(static_mask, cv2.COLOR_GRAY2BGR)
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if bg_color is None:
                bg_color = sample_bg_color(frame, static_mask)
                print(f"Background fill color (BGR): {bg_color}")
            fill = np.full_like(frame, bg_color)
            blanked = np.where(mask_3ch > 0, fill, frame)
            coverages.append((static_mask > 0).sum() / (w * h) * 100)
            out_mask.write(static_mask)
            out_blank.write(blanked)
            i += 1
        cap.release()
        out_mask.release()
        out_blank.release()
        print(f"Wrote {i} frames.")
        if coverages:
            print(f"Mask coverage: avg={coverages[0]:.1f}% (static mask).")
        return

    # === Modes: luma / color (classical threshold pipeline) =================

    roi_mask = build_roi_mask(roi, w, h)

    # First pass: compute the persistent-overlay mask (pixels that pass
    # the threshold in enough frames to be a locked-in graphic, not a
    # fluctuating background). Skipped when persistence_threshold <= 0.
    persistent = compute_persistence_mask(
        src, mode, luma_threshold, hsv_lower, hsv_upper,
        roi_mask=roi_mask, persistence_threshold=persistence_threshold,
    )

    # Second pass: write mask + blank frames using the persistence mask
    # as an additional gate. Opening the capture again is cheaper than
    # buffering every frame in RAM for a 1080p shot.
    cap.release()
    cap = cv2.VideoCapture(src)

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out_mask = cv2.VideoWriter(dst_mask, fourcc, fps, (w, h), isColor=False)
    out_blank = cv2.VideoWriter(dst_blank, fourcc, fps, (w, h), isColor=True)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (dilate_kernel, dilate_kernel))

    bg_color = None
    coverages = []
    i = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        mask = raw_detection_mask(frame, mode, luma_threshold, hsv_lower, hsv_upper)

        # 1. Gate by ROI before anything else. If the user / model says
        #    the graphic is in the lower third, everything above that
        #    y-coordinate can't be text by definition.
        mask = cv2.bitwise_and(mask, roi_mask)

        # 2. Temporal persistence gate — keep only pixels that stay lit
        #    across enough frames to count as a locked overlay. This is
        #    the step that kills bright skies / highlights that roll by
        #    with the camera: even if any single frame puts them over the
        #    luma threshold, they don't sit on the same (x, y) long
        #    enough to meet the persistence cutoff.
        if persistent is not None:
            mask = cv2.bitwise_and(mask, persistent)

        # 3. Drop oversized connected components. Belt-and-suspenders
        #    with persistence: catches static blown-out backgrounds that
        #    DID persist (sky that doesn't move in a static shot) and
        #    would otherwise slip through.
        mask = filter_large_blobs(mask, max_blob_area_pct, w, h)

        # 4. Dilate the survivors to cover anti-aliasing / drop shadows.
        mask = cv2.dilate(mask, kernel, iterations=dilate_iter)

        # Sample bg color on first frame (from areas outside the mask)
        if bg_color is None:
            bg_color = sample_bg_color(frame, mask)
            print(f"Background fill color (BGR): {bg_color}")

        mask_3ch = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
        fill = np.full_like(frame, bg_color)
        blanked = np.where(mask_3ch > 0, fill, frame)

        coverages.append((mask > 0).sum() / (w * h) * 100)
        out_mask.write(mask)
        out_blank.write(blanked)
        i += 1

    cap.release()
    out_mask.release()
    out_blank.release()
    print(f"Wrote {i} frames.")
    if coverages:
        print(f"Mask coverage: min={min(coverages):.1f}%, max={max(coverages):.1f}%, avg={sum(coverages)/len(coverages):.1f}%")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--mode", choices=["luma", "color", "boxes"], default="luma")
    p.add_argument("--luma-threshold", type=int, default=195)
    p.add_argument("--hsv-lower", nargs=3, type=int, default=[35, 120, 100], help="H S V lower bound (OpenCV 0-180, 0-255, 0-255)")
    p.add_argument("--hsv-upper", nargs=3, type=int, default=[55, 255, 255], help="H S V upper bound")
    p.add_argument("--dilate-kernel", type=int, default=25)
    p.add_argument("--dilate-iter", type=int, default=2)
    p.add_argument("--roi", default=None,
                   help="Restrict mask to a region: full_frame | top | bottom | center | lower_third | upper_third | corner_top_left | corner_top_right | corner_bottom_left | corner_bottom_right | scattered")
    p.add_argument("--max-blob-area-pct", type=float, default=15.0,
                   help="Drop connected components larger than this %% of the frame. 0 or negative disables the filter.")
    p.add_argument("--persistence-threshold", type=float, default=0.60,
                   help="Fraction of frames a pixel must be detected in to count as a persistent overlay. 0 disables the temporal gate; 0.6 means a pixel lit in 60%% of frames is kept, transient bright pixels are dropped.")
    p.add_argument("--bboxes", default=None,
                   help="When --mode=boxes: JSON string with a list of objects containing 'box_2d': [ymin, xmin, ymax, xmax] in 0-1000 normalised coords. Alternative to --bboxes-file.")
    p.add_argument("--bboxes-file", default=None,
                   help="When --mode=boxes: path to a JSON file with the same shape as --bboxes. Useful when the list is too long for a CLI arg.")
    p.add_argument("--boxes-padding-pct", type=float, default=None,
                   help="Shorthand: apply the same padding to both axes. Overrides --boxes-padding-pct-x/-y when set.")
    p.add_argument("--boxes-padding-pct-x", type=float, default=7.0,
                   help="Horizontal padding around each box, as %% of frame width. Absorbs Gemini localisation wobble on the X axis.")
    p.add_argument("--boxes-padding-pct-y", type=float, default=10.0,
                   help="Vertical padding around each box, as %% of frame height. Needs to be bigger than X because Gemini tends to clip ascenders / descenders / letterbox bands on text overlays.")
    p.add_argument("--boxes-offset-pct-x", type=float, default=0.0,
                   help="Horizontal shift of every box, as %% of frame width. Positive = right. Default 0.")
    p.add_argument("--boxes-offset-pct-y", type=float, default=5.0,
                   help="Vertical shift of every box, as %% of frame height. Positive = down. Default 5%% compensates for Gemini's systematic upward bias on text overlays.")
    args = p.parse_args()

    # Parse boxes (from --bboxes json string or --bboxes-file path).
    parsed_boxes = None
    if args.mode == "boxes":
        raw = None
        if args.bboxes_file:
            with open(args.bboxes_file, "r", encoding="utf-8") as fh:
                raw = fh.read()
        elif args.bboxes:
            raw = args.bboxes
        if not raw:
            raise SystemExit("--mode=boxes requires --bboxes or --bboxes-file.")
        try:
            parsed_boxes = json.loads(raw)
        except json.JSONDecodeError as e:
            raise SystemExit(f"Could not parse --bboxes JSON: {e}")
        if not isinstance(parsed_boxes, list):
            raise SystemExit("--bboxes must be a JSON array.")

    base = os.path.splitext(args.src)[0]
    dst_mask = f"{base}_mask.mp4"
    dst_blank = f"{base}_blank.mp4"

    # `--boxes-padding-pct` (shorthand) wins when set; otherwise honour
    # the separate X / Y flags so callers can dial them independently.
    pad_x = args.boxes_padding_pct if args.boxes_padding_pct is not None else args.boxes_padding_pct_x
    pad_y = args.boxes_padding_pct if args.boxes_padding_pct is not None else args.boxes_padding_pct_y

    make_mask(args.src, dst_mask, dst_blank,
              mode=args.mode,
              luma_threshold=args.luma_threshold,
              hsv_lower=tuple(args.hsv_lower), hsv_upper=tuple(args.hsv_upper),
              dilate_kernel=args.dilate_kernel, dilate_iter=args.dilate_iter,
              roi=args.roi, max_blob_area_pct=args.max_blob_area_pct,
              persistence_threshold=args.persistence_threshold,
              boxes=parsed_boxes,
              boxes_padding_pct_x=pad_x, boxes_padding_pct_y=pad_y,
              boxes_offset_pct_x=args.boxes_offset_pct_x,
              boxes_offset_pct_y=args.boxes_offset_pct_y)
    print(f"\nMask: {dst_mask}")
    print(f"Blank: {dst_blank}")
