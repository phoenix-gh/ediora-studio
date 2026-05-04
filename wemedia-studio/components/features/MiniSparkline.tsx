'use client'

interface Props {
  data: number[]
  height?: number
  color?: string
  fill?: boolean
  className?: string
}

export function MiniSparkline({ data, height = 28, color = '#6366f1', fill = false, className }: Props) {
  if (!data.length) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const pad = 2
  const vbWidth = 100

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (vbWidth - pad * 2)
    const y = pad + (1 - (v - min) / range) * (height - pad * 2)
    return `${x},${y}`
  })

  const firstPt = points[0].split(',')
  const lastPt = points[points.length - 1].split(',')

  return (
    <svg
      viewBox={`0 0 ${vbWidth} ${height}`}
      preserveAspectRatio="none"
      className={className ?? 'w-full overflow-visible'}
      style={className ? undefined : { height }}
    >
      {fill && (
        <polygon
          points={[
            `${firstPt[0]},${height}`,
            ...points,
            `${lastPt[0]},${height}`,
          ].join(' ')}
          fill={color}
          fillOpacity={0.1}
        />
      )}
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
