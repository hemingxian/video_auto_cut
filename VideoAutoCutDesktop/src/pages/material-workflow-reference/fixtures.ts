import type {
  ReferenceFolder,
  ReferenceMaterial,
  ReferenceSelection,
} from './model'

export type ReferenceShot = {
  id: number
  title: string
  timeRange: string
  voiceText: string
  searchQuery: string
  visualQuery: string
  clipRequirements: string
  selections: ReferenceSelection[]
}

export const referenceFolders: ReferenceFolder[] = [
  { id: 'all', name: '全部素材', videoCount: 243, folderCount: 6 },
  { id: 'project', name: '项目素材', videoCount: 24, folderCount: 2 },
  { id: 'product', name: '产品展示', videoCount: 12, folderCount: 2 },
  { id: 'factory', name: '工业园区', videoCount: 18, folderCount: 3 },
  { id: 'city', name: '城市空镜', videoCount: 16, folderCount: 1 },
  { id: 'interview', name: '人物访谈', videoCount: 8, folderCount: 0 },
  { id: 'scene', name: '场景空镜', videoCount: 31, folderCount: 4 },
  { id: 'cloud', name: '云端下载', videoCount: 6, folderCount: 0 },
]

export const referenceMaterials: ReferenceMaterial[] = [
  {
    id: 'storage-front',
    name: '智能储能柜_正面展示.mp4',
    size: '118.0 MB',
    duration: '00:42',
    resolution: '1920 × 1080',
    folderId: 'product',
    folderName: '产品展示',
    status: 'ready',
    storage: 'both',
    visibility: 'private',
    sprite: 'a',
    spritePosition: '0% 0%',
  },
  {
    id: 'product-close',
    name: '产品演示_特写01.mp4',
    size: '75.0 MB',
    duration: '00:28',
    resolution: '3840 × 2160',
    folderId: 'product',
    folderName: '产品展示',
    status: 'ready',
    storage: 'local',
    visibility: 'private',
    sprite: 'a',
    spritePosition: '100% 0%',
  },
  {
    id: 'product-speaker',
    name: '产品演示_讲解.mp4',
    size: '92.0 MB',
    duration: '01:15',
    resolution: '1920 × 1080',
    folderId: 'product',
    folderName: '产品展示',
    status: 'ready',
    storage: 'cloud',
    visibility: 'public',
    sprite: 'a',
    spritePosition: '0% 100%',
  },
  {
    id: 'meeting',
    name: '产品演示_会议现场.mp4',
    size: '84.0 MB',
    duration: '00:36',
    resolution: '1920 × 1080',
    folderId: 'product',
    folderName: '产品展示',
    status: 'ready',
    storage: 'local',
    visibility: 'private',
    sprite: 'a',
    spritePosition: '100% 100%',
  },
  {
    id: 'production-line',
    name: '产品演示_产线.mp4',
    size: '128.7 MB',
    duration: '00:31',
    resolution: '2560 × 1440',
    folderId: 'factory',
    folderName: '工业园区',
    status: 'ready',
    storage: 'both',
    visibility: 'private',
    sprite: 'b',
    spritePosition: '0% 0%',
  },
  {
    id: 'module-detail',
    name: '模块接口_细节镜头.mov',
    size: '92.0 MB',
    duration: '00:27',
    resolution: '1920 × 1080',
    folderId: 'factory',
    folderName: '工业园区',
    status: 'processing',
    storage: 'local',
    visibility: 'private',
    sprite: 'b',
    spritePosition: '100% 0%',
  },
  {
    id: 'dashboard',
    name: '产品演示_功能界面.mp4',
    size: '103.0 MB',
    duration: '00:45',
    resolution: '2560 × 1440',
    folderId: 'factory',
    folderName: '工业园区',
    status: 'ready',
    storage: 'cloud',
    visibility: 'private',
    sprite: 'b',
    spritePosition: '0% 100%',
  },
  {
    id: 'warehouse',
    name: '产品演示_客户案例.mp4',
    size: '137.0 MB',
    duration: '00:39',
    resolution: '2560 × 1440',
    folderId: 'factory',
    folderName: '工业园区',
    status: 'failed',
    storage: 'local',
    visibility: 'private',
    sprite: 'b',
    spritePosition: '100% 100%',
  },
]

export const referenceShots: ReferenceShot[] = [
  {
    id: 1,
    title: '开场：城市与清洁能源',
    timeRange: '00:00–00:08',
    voiceText: '每一次能源革新，都在重新定义城市的未来。',
    searchQuery: '现代城市 天际线 清洁能源',
    visualQuery: '清晨城市天际线，阳光穿过高楼，镜头缓慢推进。',
    clipRequirements: '节奏舒缓，使用淡入转场，画面保持稳定。',
    selections: [{
      id: 'city',
      kind: 'folder',
      name: '城市空镜',
      videoCount: 16,
    }],
  },
  {
    id: 2,
    title: '核心：智能储能产品展示',
    timeRange: '00:08–00:20',
    voiceText: '智能储能系统，让每一度电都得到更高效、更可靠的利用。',
    searchQuery: '储能设备 产品细节 工业设计',
    visualQuery: '白色智能储能设备特写，展示屏、接口和模块化结构。',
    clipRequirements: '从全景切换到三处细节特写，转场干净，突出科技感。',
    selections: [],
  },
  {
    id: 3,
    title: '应用：园区能源调度',
    timeRange: '00:20–00:29',
    voiceText: '从园区到家庭，系统实时响应每一个用能需求。',
    searchQuery: '工业园区 能源管理 控制中心',
    visualQuery: '现代工业园区航拍和控制中心操作画面交替出现。',
    clipRequirements: '保持蓝绿色调，画面之间使用快速叠化。',
    selections: [],
  },
]

export const initialPickerSelections: ReferenceSelection[] = [
  {
    id: 'product',
    kind: 'folder',
    name: '产品展示',
    includeSubfolders: true,
    videoCount: 12,
  },
  {
    id: 'factory',
    kind: 'folder',
    name: '工业园区',
    includeSubfolders: false,
    videoCount: 18,
  },
  {
    id: 'storage-front',
    kind: 'material',
    name: '智能储能柜_正面展示.mp4',
  },
  {
    id: 'product-close',
    kind: 'material',
    name: '产品演示_特写01.mp4',
  },
]
