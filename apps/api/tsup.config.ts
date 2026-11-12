import { defineConfig } from 'tsup';

// Bundle only our own workspace packages (they ship as TypeScript source). Every third-party
// import stays external and is installed normally in production — bundling libraries such as
// BullMQ or the AWS SDK breaks their internal file lookups and bloats the output.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@vd\//],
  external: [/^(?!@vd\/)[^./]/],
});
