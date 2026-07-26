import { redirect } from 'next/navigation'

export default function LegacyXResponsesPage() {
  redirect('/responses?source_type=x_post')
}
