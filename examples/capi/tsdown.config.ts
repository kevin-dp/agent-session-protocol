import type { Options } from "tsdown"

const config: Options = {
  entry: ["src/cli.ts", "src/queue-channel.ts"],
  format: ["esm"],
  platform: "node",
  clean: true,
}

export default config
