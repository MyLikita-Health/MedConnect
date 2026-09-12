import { defineConfig } from 'vitepress'

// Set DOCS_BASE=/MedConnect/ when deploying to GitHub Pages under the repo
// path (see .github/workflows/docs.yml); local dev uses '/'.
const base = process.env.DOCS_BASE || '/'

export default defineConfig({
  base,
  title: 'Integration Hub',
  description: 'Healthcare device interoperability platform — documentation and guides',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    siteTitle: 'Integration Hub Docs',
    nav: [
      { text: 'Guide', link: '/guide/overview' },
      { text: 'GitHub', link: 'https://github.com/MyLikita-Health/MedConnect' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guides',
          items: [
            { text: 'Project overview', link: '/guide/overview' },
            { text: 'Infrastructure', link: '/guide/infrastructure' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Setup', link: '/guide/setup' },
            { text: 'Devices & connections', link: '/guide/devices' },
            { text: 'Usage', link: '/guide/usage' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/MyLikita-Health/MedConnect/edit/main/docs-site/:path',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/MyLikita-Health/MedConnect' }],
    footer: {
      copyright: 'MyLikita Health',
    },
  },
})