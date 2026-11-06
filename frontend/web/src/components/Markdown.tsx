import { memo } from 'react';

/** One finished top-level block. Memoised on its HTML, so React skips it entirely once it stops changing. */
export const Block = memo(function Block({ html }: { html: string }) {
  return <div className="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
});

export function Blocks({ blocks }: { blocks: string[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} html={b} />
      ))}
    </>
  );
}
