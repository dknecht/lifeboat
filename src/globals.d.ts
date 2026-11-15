// The Worker entry passes its own module URL to Alchemy so that the bundler knows where to start.
interface ImportMeta {
  readonly url: string;
}
