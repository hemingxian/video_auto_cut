import { Boxes, History, Mic2, Play, Settings } from 'lucide-react'
import type { NavItem } from '../types/app'

export const navItems: NavItem[] = [
  { id: 'start', label: '开始任务', description: '选择脚本并生成视频', icon: Play },
  { id: 'runs', label: '历史任务', description: '查看日志和输出文件', icon: History },
  { id: 'materials', label: '素材库', description: '管理和检索视频素材', icon: Boxes },
  { id: 'voice', label: '音色克隆', description: '声音样本与音色模板', icon: Mic2 },
  { id: 'config', label: '设置', description: '生成、画面和更新设置', icon: Settings },
]
