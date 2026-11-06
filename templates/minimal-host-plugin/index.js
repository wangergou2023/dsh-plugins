/**
 * Host half of the bundle.
 *
 * A Cordis plugin: export `apply(ctx, config)` (or a service class as the
 * default export). Register everything inside `apply`, using `ctx.effect`
 * or `ctx.on`, and return a cleanup function so the plugin can be
 * disabled/uninstalled without leaking resources.
 */
export const inject = []

export const Config = {
  type: 'object',
  properties: {
    greeting: {
      type: 'string',
      description: 'Text the plugin logs once when it activates.',
      default: 'Hello from my-plugin',
    },
  },
  additionalProperties: false,
}

export function apply(ctx, config) {
  const greeting = config?.greeting ?? 'Hello from my-plugin'

  // `ctx.logger` is available on the plugin context. Nothing is registered
  // outside `apply`, so a failed activation leaves no partial state behind.
  ctx.logger?.info?.(greeting)

  // Register a tool, a route, a listener… here. Example:
  //
  //   ctx.effect(() => {
  //     const dispose = ctx.tools.register(...)
  //     return dispose
  //   })
  //
  // Returning nothing is fine: an empty Host plugin is still a valid bundle
  // and shows up in Plugin Manager once installed.
}
