// Types for the classic (untyped) markdown.js, imported through the `@classic` alias (see vite.config.ts).
declare module '@classic/markdown.js' {
  export function processWithThinking(text: string): string;
  export function squashOutsideCode(text: string): string;
  export function extractThinkingBlocks(text: string): { thinkingBlocks: string[]; content: string; thinkingTime: string | null };
  export function hasUnclosedThinkTag(text: string): boolean;
  export function startsWithReasoningPrefix(text: string): boolean;
}
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
