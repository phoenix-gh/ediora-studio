import { create } from 'zustand'
import { Topic, TopicStatus } from '@/lib/types'
import { updateTopicStatus } from '@/lib/api/topics'

interface TopicsStore {
  topics: Topic[]
  selectedTopicId: string | null
  isDrawerOpen: boolean
  setTopics: (topics: Topic[]) => void
  updateStatus: (id: string, status: TopicStatus) => Promise<void>
  selectTopic: (id: string | null) => void
  closeDrawer: () => void
}

export const useTopicsStore = create<TopicsStore>((set) => ({
  topics: [],
  selectedTopicId: null,
  isDrawerOpen: false,

  setTopics: (topics) => set({ topics }),

  updateStatus: async (id, status) => {
    await updateTopicStatus(id, status)
    set((state) => ({
      topics: state.topics.map(t => t.id === id ? { ...t, status } : t),
    }))
  },

  selectTopic: (id) => set({ selectedTopicId: id, isDrawerOpen: id !== null }),

  closeDrawer: () => set({ isDrawerOpen: false, selectedTopicId: null }),
}))
