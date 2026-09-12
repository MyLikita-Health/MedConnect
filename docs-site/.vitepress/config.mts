import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

// Set DOCS_BASE=/MedConnect/ when deploying to GitHub Pages under the repo
// path (see .github/workflows/docs.yml); local dev uses '/'.
const base = process.env.DOCS_BASE || '/'

const ogImage = '/og.png'
const ogUrl = 'https://mylikita-health.github.io/MedConnect'
const ogImageUrl = ogUrl + ogImage

// Home-page stamp inputs, computed at build time. Version comes from the
// root package.json (single source of truth with the hub itself); the docs
// date from the last commit that touched docs-site. CI must check out with
// fetch-depth: 0 or the date silently falls back to "today".
const siteRoot = fileURLToPath(new URL('..', import.meta.url))
const docsVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version

let docsCommit = 'source'
let docsUpdated = new Date().toISOString().slice(0, 10)
try {
  docsCommit = execSync('git log -1 --format=%h -- .', { cwd: siteRoot, encoding: 'utf8' }).trim() || docsCommit
  const iso = execSync('git log -1 --format=%cs -- .', { cwd: siteRoot, encoding: 'utf8' }).trim()
  if (iso) docsUpdated = iso
} catch {
  // e.g. a build without git history — keep the fallbacks above
}
const docsUpdatedLabel = new Date(docsUpdated + 'T00:00:00Z').toLocaleDateString('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
})

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
    // Custom keys consumed by theme/HomeStamp.vue (serialized into the
    // client payload; absent from the default theme's types — expected).
    docsVersion,
    docsUpdated: docsUpdatedLabel,
    docsCommit,
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
            { text: 'Service management', link: '/guide/service-management' },
            { text: 'Devices & connections', link: '/guide/devices' },
            { text: 'Device certification', link: '/guide/certification' },
            { text: 'Usage', link: '/guide/usage' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            { text: 'FAQ', link: '/guide/faq' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'REST API', link: '/reference/rest-api' },
            { text: 'Security & privacy', link: '/reference/security' },
            { text: 'Licensing (AGPL boundary)', link: '/reference/licensing' },
          ],
        },
      ],
    },
    lastUpdated: {
      text: 'Updated',
      formatOptions: { dateStyle: 'long', locale: 'en-US' },
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
