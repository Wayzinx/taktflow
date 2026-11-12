import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FacetTags } from './facet-tags'

it('评审标签不把上一轮未关闭的重要问题显示成干净通过', () => {
  const html = renderToStaticMarkup(createElement(FacetTags, { facets: {
    phase: 'done', outcome: 'no_findings', coverage: 'full', freshness: 'current',
    open: { blocker: 0, major: 1, minor: 0, nit: 0 },
  } }))
  expect(html).toContain('本轮无新问题 · 遗留 1')
  expect(html).not.toContain('>无问题<')
})
