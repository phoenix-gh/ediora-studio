import { getMaterials, getCategories } from '@/lib/api/materials'
import { getWritingPlans } from '@/lib/api/writing-plans'
import { MaterialsClient } from './MaterialsClient'

export const dynamic = 'force-dynamic'

export default async function MaterialsPage() {
  const [materials, categories, plans] = await Promise.all([
    getMaterials(), getCategories(), getWritingPlans(),
  ])
  return <MaterialsClient initialMaterials={materials} categories={categories} initialPlans={plans} />
}
