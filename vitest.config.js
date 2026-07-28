import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{js,jsx}',
      'electron/**/*.test.js',
      'tests/**/*.test.js',
    ],
  },
})
