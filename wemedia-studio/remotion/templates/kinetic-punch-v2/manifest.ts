import type { TextVideoTemplateManifest } from '../../types'
import { KineticPunchV2Composition } from './Composition'
import {
  KINETIC_PUNCH_V2_DEFAULTS,
  KINETIC_PUNCH_V2_SETTINGS,
  kineticPunchV2PropsSchema,
  type KineticPunchV2Props,
} from './config'

export const kineticPunchV2Manifest = {
  id: 'kinetic-punch-v2',
  version: 1,
  compositionId: 'kinetic-punch-v2',
  name: '动感大字 V2',
  description: '语义短句、逐词卡点与无闪空的信息差冲击动效',
  component: KineticPunchV2Composition,
  propsSchema: kineticPunchV2PropsSchema,
  defaultComposition: { width: 1080, height: 1920, fps: 30 },
  aspectRatios: ['9:16', '16:9', '1:1'],
  animations: ['impact', 'reveal', 'contrast'],
  transitions: ['block-wipe'],
  defaults: KINETIC_PUNCH_V2_DEFAULTS,
  settings: KINETIC_PUNCH_V2_SETTINGS,
} as const satisfies TextVideoTemplateManifest<KineticPunchV2Props>
