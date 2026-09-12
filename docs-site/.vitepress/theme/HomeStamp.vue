<script setup lang="ts">
import { useData } from 'vitepress'

// Custom themeConfig keys (docsVersion / docsUpdated) are computed in
// .vitepress/config.mts at build time and serialized into the payload.
const { theme } = useData()
</script>

<template>
  <p v-if="theme.docsUpdated" class="docs-stamp">
    <span class="docs-stamp-badge">v{{ theme.docsVersion }}</span>
    <span class="docs-stamp-dot" aria-hidden="true">&middot;</span>
    <span>Docs updated {{ theme.docsUpdated }}</span>
  </p>
</template>
