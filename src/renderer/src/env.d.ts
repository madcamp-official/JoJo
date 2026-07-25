import type { NuanceApi } from '../../preload/index'

declare global {
  interface Window {
    nuance: NuanceApi
  }
}

export {}
