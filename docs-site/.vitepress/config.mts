import { defineConfig } from 'vitepress'

// Set DOCS_BASE=/MedConnect/ when deploying to GitHub Pages under the repo
// path (see .github/workflows/docs.yml); local dev uses '/'.
const base = process.env.DOCS_BASE || '/'

const ogImage = '/og.png'
const ogUrl = 'https://mylikita-health.github.io/MedConnect'
const ogImageUrl = ogUrl + ogImage

export default defineConfig({
  base,
  title: 'Integration Hub',
  description: 'Healthcare device interoperability platform — documentation and guides',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg`.replace('//', '/') }],
    ['link', { rel: 'apple-touch-icon', href: `${base}favicon.svg`.replace('//', '/') }],
    ['meta', { name: 'theme-color', content: '#2563eb' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Integration Hub Docs' }],
    ['meta', { property: 'og:title', content: 'Integration Hub — Documentation' }],
    ['meta', { property: 'og:description', content: 'Guides for installing, configuring and operating the healthcare interoperability hub — ASTM, HL7 v2 and DICOM via Orthanc.' }],
    ['meta', { property: 'og:image', content: ogImageUrl }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: 'Integration Hub — pulse-line logo on medical blue, with the tagline “One hub for every device” and the supported protocols: ASTM, HL7 v2, DICOM' }],
    ['meta', { property: 'og:url', content: ogUrl }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Integration Hub — Documentation' }],
    ['meta', { name: 'twitter:description', content: 'Guides for installing, configuring and operating the healthcare interoperability hub — ASTM, HL7 v2 and DICOM via Orthanc.' }],
    ['meta', { name: 'twitter:image', content: ogImageUrl }],
    ['meta', { name: 'twitter:image:alt', content: 'Integration Hub — pulse-line logo on medical blue, with the tagline “One hub for every device” and the supported protocols: ASTM, HL7 v2, DICOM' }],
  ],

  themeConfig: {
    siteTitle: 'Integration Hub Docs',
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/overview' },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'REST API', link: '/reference/rest-api' },
        ],
      },
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
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'REST API', link: '/reference/rest-api' },
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
