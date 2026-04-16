function toGraphNodeId(value) {
  const raw = String(value ?? '').trim()
  return /^\d+$/.test(raw) ? Number(raw) : raw
}

function isLinkValue(value, nodeIdSet) {
  if (!Array.isArray(value) || value.length !== 2) return false
  const upstreamId = String(value[0] ?? '').trim()
  if (!upstreamId || !nodeIdSet.has(upstreamId)) return false
  const slot = value[1]
  return Number.isInteger(slot) || (typeof slot === 'string' && slot.length > 0)
}

function getInputSpec(nodeSchema = null, inputName = '') {
  if (!nodeSchema || !inputName) return null
  return (
    nodeSchema?.input?.required?.[inputName]
    || nodeSchema?.input?.optional?.[inputName]
    || null
  )
}

function getSpecType(inputSpec = null) {
  if (!Array.isArray(inputSpec) || inputSpec.length === 0) return '*'
  const base = inputSpec[0]
  if (Array.isArray(base)) return base
  return base ?? '*'
}

function getPortType(inputSpec = null) {
  const type = getSpecType(inputSpec)
  if (Array.isArray(type)) return 'COMBO'
  return type || '*'
}

function getOrderedInputNames(nodeSchema = null, inputs = {}) {
  const requiredOrder = Array.isArray(nodeSchema?.input_order?.required) ? nodeSchema.input_order.required : []
  const optionalOrder = Array.isArray(nodeSchema?.input_order?.optional) ? nodeSchema.input_order.optional : []
  const declared = [...requiredOrder, ...optionalOrder]
  const seen = new Set()
  const ordered = []

  for (const name of declared) {
    if (seen.has(name)) continue
    seen.add(name)
    ordered.push(name)
  }

  for (const name of Object.keys(inputs || {})) {
    if (seen.has(name)) continue
    seen.add(name)
    ordered.push(name)
  }

  return ordered
}

function cloneJsonValue(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

function computeNodeDepths(nodeIds = [], incomingByNode = new Map()) {
  const memo = new Map()
  const visiting = new Set()

  const visit = (nodeId) => {
    if (memo.has(nodeId)) return memo.get(nodeId)
    if (visiting.has(nodeId)) return 0
    visiting.add(nodeId)

    const parents = Array.from(incomingByNode.get(nodeId) || [])
    const depth = parents.length === 0
      ? 0
      : Math.max(...parents.map((parentId) => visit(parentId) + 1))

    visiting.delete(nodeId)
    memo.set(nodeId, depth)
    return depth
  }

  for (const nodeId of nodeIds) {
    visit(nodeId)
  }

  return memo
}

function buildNodePositions(nodeIds = [], incomingByNode = new Map()) {
  const depthMap = computeNodeDepths(nodeIds, incomingByNode)
  const indexByDepth = new Map()
  const positions = new Map()

  for (const nodeId of nodeIds) {
    const depth = depthMap.get(nodeId) || 0
    const row = indexByDepth.get(depth) || 0
    indexByDepth.set(depth, row + 1)
    positions.set(nodeId, [
      40 + depth * 420,
      40 + row * 220,
    ])
  }

  return positions
}

function estimateNodeSize(linkInputs = [], outputs = [], widgetValues = []) {
  const visibleRows = Math.max(linkInputs.length, outputs.length, 1)
  const height = 70 + (visibleRows * 24) + (widgetValues.length * 18)
  const width = 320 + Math.min(80, widgetValues.length * 6)
  return [width, Math.max(100, height)]
}

function buildWorkflowLinks(apiWorkflow = {}, objectInfo = {}) {
  const nodeIds = Object.keys(apiWorkflow || {})
  const nodeIdSet = new Set(nodeIds)
  const linkInputsByNode = new Map()
  const outputLinksByNode = new Map()
  const incomingByNode = new Map(nodeIds.map((nodeId) => [nodeId, new Set()]))
  const links = []
  let nextLinkId = 1

  for (const targetNodeId of nodeIds) {
    const nodeDef = apiWorkflow?.[targetNodeId] || {}
    const nodeSchema = objectInfo?.[nodeDef.class_type] || null

    for (const [inputName, inputValue] of Object.entries(nodeDef.inputs || {})) {
      if (!isLinkValue(inputValue, nodeIdSet)) continue

      const originNodeId = String(inputValue[0])
      const originSlot = /^\d+$/.test(String(inputValue[1])) ? Number(inputValue[1]) : inputValue[1]
      const inputSpec = getInputSpec(nodeSchema, inputName)
      const link = {
        id: nextLinkId++,
        origin_id: toGraphNodeId(originNodeId),
        origin_slot: originSlot,
        target_id: toGraphNodeId(targetNodeId),
        target_slot: inputName,
        type: getPortType(inputSpec),
      }

      links.push(link)

      const targetInputs = linkInputsByNode.get(targetNodeId) || []
      targetInputs.push({
        name: inputName,
        type: getPortType(inputSpec),
        link: link.id,
      })
      linkInputsByNode.set(targetNodeId, targetInputs)

      const sourceSlots = outputLinksByNode.get(originNodeId) || new Map()
      const slotLinks = sourceSlots.get(originSlot) || []
      slotLinks.push(link.id)
      sourceSlots.set(originSlot, slotLinks)
      outputLinksByNode.set(originNodeId, sourceSlots)

      incomingByNode.get(targetNodeId)?.add(originNodeId)
    }
  }

  return {
    links,
    linkInputsByNode,
    outputLinksByNode,
    incomingByNode,
    lastLinkId: nextLinkId - 1,
  }
}

function buildOutputPorts(nodeSchema = null, nodeOutputLinks = new Map()) {
  const outputTypes = Array.isArray(nodeSchema?.output) ? nodeSchema.output : []
  const outputNames = Array.isArray(nodeSchema?.output_name) ? nodeSchema.output_name : []
  const linkedSlots = Array.from(nodeOutputLinks.keys()).map((slot) => Number(slot)).filter(Number.isFinite)
  const maxLinkedSlot = linkedSlots.length > 0 ? Math.max(...linkedSlots) : -1
  const totalSlots = Math.max(outputTypes.length, outputNames.length, maxLinkedSlot + 1, 0)
  const outputs = []

  for (let slotIndex = 0; slotIndex < totalSlots; slotIndex += 1) {
    const outputType = outputTypes[slotIndex] ?? '*'
    outputs.push({
      name: outputNames[slotIndex] || `output_${slotIndex}`,
      type: outputType,
      slot_index: slotIndex,
      links: nodeOutputLinks.get(slotIndex) || null,
    })
  }

  return outputs
}

function buildWidgetValues(nodeDef = {}, nodeSchema = null, nodeIdSet = new Set()) {
  const orderedNames = getOrderedInputNames(nodeSchema, nodeDef.inputs || {})
  const used = new Set()
  const values = []

  for (const inputName of orderedNames) {
    if (!(inputName in (nodeDef.inputs || {}))) continue
    const inputValue = nodeDef.inputs[inputName]
    if (isLinkValue(inputValue, nodeIdSet)) continue
    values.push(cloneJsonValue(inputValue))
    used.add(inputName)
  }

  for (const [inputName, inputValue] of Object.entries(nodeDef.inputs || {})) {
    if (used.has(inputName) || isLinkValue(inputValue, nodeIdSet)) continue
    values.push(cloneJsonValue(inputValue))
  }

  return values
}

export function convertApiWorkflowToComfyGraph(apiWorkflow = {}, objectInfo = {}) {
  const nodeIds = Object.keys(apiWorkflow || {}).sort((left, right) => {
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber
    }
    return String(left).localeCompare(String(right))
  })
  const nodeIdSet = new Set(nodeIds)
  const {
    links,
    linkInputsByNode,
    outputLinksByNode,
    incomingByNode,
    lastLinkId,
  } = buildWorkflowLinks(apiWorkflow, objectInfo)
  const positions = buildNodePositions(nodeIds, incomingByNode)

  const nodes = nodeIds.map((nodeId, index) => {
    const nodeDef = apiWorkflow[nodeId] || {}
    const nodeSchema = objectInfo?.[nodeDef.class_type] || null
    const orderedInputNames = getOrderedInputNames(nodeSchema, nodeDef.inputs || {})
    const inputOrder = new Map(orderedInputNames.map((inputName, inputIndex) => [inputName, inputIndex]))
    const linkInputs = (linkInputsByNode.get(nodeId) || []).sort((left, right) => {
      const leftOrder = inputOrder.get(left.name)
      const rightOrder = inputOrder.get(right.name)
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
      if (leftOrder !== undefined) return -1
      if (rightOrder !== undefined) return 1
      return left.name.localeCompare(right.name)
    })
    const outputs = buildOutputPorts(nodeSchema, outputLinksByNode.get(nodeId) || new Map())
    const widgetValues = buildWidgetValues(nodeDef, nodeSchema, nodeIdSet)
    const position = positions.get(nodeId) || [40, 40 + index * 220]

    return {
      id: toGraphNodeId(nodeId),
      type: nodeDef.class_type,
      pos: position,
      size: estimateNodeSize(linkInputs, outputs, widgetValues),
      flags: {},
      order: index,
      mode: 0,
      inputs: linkInputs,
      outputs,
      title: nodeDef?._meta?.title || nodeSchema?.display_name || nodeDef.class_type,
      properties: {
        'Node name for S&R': nodeDef.class_type,
      },
      widgets_values: widgetValues,
    }
  })

  const numericNodeIds = nodeIds
    .map((nodeId) => Number(nodeId))
    .filter((nodeId) => Number.isFinite(nodeId))

  return {
    version: 1,
    config: {},
    state: {
      lastGroupid: 0,
      lastNodeId: numericNodeIds.length > 0 ? Math.max(...numericNodeIds) : nodes.length,
      lastLinkId,
      lastRerouteId: 0,
    },
    groups: [],
    nodes,
    links,
    reroutes: [],
    extra: {},
  }
}

export async function buildComfyGraphFromApiWorkflow(apiWorkflow = {}, objectInfo = {}) {
  return convertApiWorkflowToComfyGraph(apiWorkflow, objectInfo)
}
