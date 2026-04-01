export type ElementType = 'text' | 'line' | 'path'

export type BoundingBox = {
  x: number
  y: number
  width: number
  height: number
}

export type ElementRecord = {
  id: string
  type: ElementType
  page: number
  bbox: BoundingBox
  displayText: string
  tags: string[]
  relations: string[]
  rawAttrs: Record<string, string | number | boolean>
}

export type AnalysisResult = {
  elementsByPage: Record<number, ElementRecord[]>
  totalElements: number
}