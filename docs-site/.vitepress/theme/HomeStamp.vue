<script setup lang="ts">
import { useData } from 'vitepress'

// Custom themeConfig keys (docsVersion / docsUpdated) are computed in
// .vitepress/config.mts at build time and serialized into the payload.
const { theme } = useData()
</script>

<template>
  <div v-if="theme.docsUpdated" class="home-hero-meta">
    <p class="docs-stamp">
      <span class="docs-stamp-badge">v{{ theme.docsVersion }}</span>
      <span class="docs-stamp-dot" aria-hidden="true">&middot;</span>
      <span>Docs updated {{ theme.docsUpdated }}</span>
    </p>
    <p class="docs-start">
      Evaluating us? Read the
      <a href="/guide/faq">FAQ</a> and the
      <a href="/reference/security">security &amp; privacy statement</a>.
    </p>
  </div>
</template>
