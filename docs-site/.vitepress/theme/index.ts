import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import HomeStamp from './HomeStamp.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-actions-after': () => h(HomeStamp),
    })
  },
}
