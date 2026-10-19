import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  theme: 'base',
  themeVariables: {
    fontSize: '16px',
    primaryColor: '#eaf4ef',
    primaryTextColor: '#17312f',
    primaryBorderColor: '#78a698',
    lineColor: '#456d65',
    textColor: '#17312f',
  },
  fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  flowchart: { htmlLabels: false, useMaxWidth: false },
  sequence: { useMaxWidth: false },
});

async function renderDiagrams() {
  for (const figure of document.querySelectorAll('.diagram')) {
    const node = figure.querySelector('.mermaid');
    const status = figure.querySelector('.diagram-status');
    const zoom = figure.querySelector('.diagram-zoom');
    try {
      await mermaid.run({ nodes: [node] });
      status.hidden = true;
      zoom.hidden = false;
      zoom.addEventListener('click', () => {
        const expanded = figure.classList.toggle('diagram-zoomed');
        zoom.textContent = expanded ? '缩小' : '放大';
        zoom.setAttribute('aria-pressed', String(expanded));
      });
    } catch {
      status.textContent = '图表无法显示，请展开源码查看。';
      node.hidden = true;
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderDiagrams, { once: true });
} else {
  renderDiagrams();
}
