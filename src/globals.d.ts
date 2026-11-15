// The Worker entry passes its own module URL to Alchemy so that the bundler knows where to start.
interface ImportMeta {
  readonly url: string;
}

// Node's process, present while Alchemy evaluates the stack for a deploy and absent in the Worker.
declare var process: { readonly env: { readonly [name: string]: string | undefined } } | undefined;
