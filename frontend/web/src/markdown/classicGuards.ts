// MUST be imported before the classic markdown.js (ES modules evaluate in import order).
// markdown.js starts a page-wide MutationObserver for its own "thinking" accordion on import; it skips that when
// this flag is already set. /play renders no classic accordion, so the observer would only cost time per streamed node.
(window as unknown as { _thinkingWatcherWired?: boolean })._thinkingWatcherWired = true;
export {};
