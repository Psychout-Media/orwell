import { memo, useMemo, useRef } from 'react';
import { advanceBlocks, emptyBlocks, splitBlocks, type BlockState } from '../markdown/blocks';
import { renderBlock } from '../markdown/render';

/** One finished block. Memoised on its source, so React skips it entirely once it stops changing. */
export const Block = memo(function Block({ src }: { src: string }) {
  const html = useMemo(() => renderBlock(src), [src]);
  return <div className="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A settled message (history rows): every block is final. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} src={b} />
      ))}
    </>
  );
});

/** The live reply. Finished blocks are committed once; only the tail block is re-rendered per frame. */
export function StreamingMarkdown({ text }: { text: string }) {
  const state = useRef<BlockState>(emptyBlocks());
  const next = advanceBlocks(state.current, text);
  state.current = next;
  return (
    <>
      {next.stable.map((b, i) => (
        <Block key={i} src={b} />
      ))}
      {next.tail.trim() ? <Block key="tail" src={next.tail} /> : null}
    </>
  );
}
