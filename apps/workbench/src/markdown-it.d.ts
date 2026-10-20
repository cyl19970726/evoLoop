declare module "markdown-it" {
  interface Token { type: string; info: string; content: string }
  export default class MarkdownIt {
    constructor(options?: { html?: boolean; linkify?: boolean; breaks?: boolean });
    options: Record<string, unknown>;
    validateLink: (url: string) => boolean;
    renderer: { render(tokens: Token[], options: Record<string, unknown>, env: object): string };
    parse(source: string, env: object): Token[];
    disable(name: string): this;
  }
}
