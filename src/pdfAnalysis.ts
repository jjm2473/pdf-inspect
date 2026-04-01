import { OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import type { AnalysisResult, BoundingBox, ElementRecord } from './types'

type ProgressCallback = (current: number, total: number) => void

type PathBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type TextItemLike = {
  str: string
  transform: number[]
  width: number
  height: number
  fontName?: string
  hasEOL?: boolean
  dir?: string
}

function isTextItemLike(value: unknown): value is TextItemLike {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as Partial<TextItemLike>
  return (
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    item.transform.length >= 6 &&
    typeof item.width === 'number' &&
    typeof item.height === 'number'
  )
}

function viewportRectToBox(
  viewport: { convertToViewportRectangle: (rect: number[]) => number[] },
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): BoundingBox {
  const projected = viewport.convertToViewportRectangle([x1, y1, x2, y2])
  const left = Math.min(projected[0], projected[2])
  const top = Math.min(projected[1], projected[3])
  const width = Math.max(1, Math.abs(projected[2] - projected[0]))
  const height = Math.max(1, Math.abs(projected[3] - projected[1]))

  return { x: left, y: top, width, height }
}

function pushPoint(bounds: PathBounds, x: number, y: number): void {
  bounds.minX = Math.min(bounds.minX, x)
  bounds.minY = Math.min(bounds.minY, y)
  bounds.maxX = Math.max(bounds.maxX, x)
  bounds.maxY = Math.max(bounds.maxY, y)
}

function parsePathBounds(operators: number[], args: number[]): PathBounds | null {
  const curveTo2 = (OPS as Record<string, number>).curveTo2
  const curveTo3 = (OPS as Record<string, number>).curveTo3

  const bounds: PathBounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  }

  let cursor = 0

  for (const operator of operators) {
    switch (operator) {
      case OPS.moveTo:
      case OPS.lineTo: {
        const x = args[cursor]
        const y = args[cursor + 1]
        cursor += 2
        if (x !== undefined && y !== undefined) {
          pushPoint(bounds, x, y)
        }
        break
      }

      case OPS.curveTo: {
        const pairs = [
          [args[cursor], args[cursor + 1]],
          [args[cursor + 2], args[cursor + 3]],
          [args[cursor + 4], args[cursor + 5]],
        ]
        cursor += 6

        for (const pair of pairs) {
          if (pair[0] !== undefined && pair[1] !== undefined) {
            pushPoint(bounds, pair[0], pair[1])
          }
        }
        break
      }

      case OPS.rectangle: {
        const x = args[cursor]
        const y = args[cursor + 1]
        const width = args[cursor + 2]
        const height = args[cursor + 3]
        cursor += 4

        if (
          x !== undefined &&
          y !== undefined &&
          width !== undefined &&
          height !== undefined
        ) {
          pushPoint(bounds, x, y)
          pushPoint(bounds, x + width, y + height)
        }
        break
      }

      default: {
        if (curveTo2 !== undefined && operator === curveTo2) {
          const pairs = [
            [args[cursor], args[cursor + 1]],
            [args[cursor + 2], args[cursor + 3]],
          ]
          cursor += 4

          for (const pair of pairs) {
            if (pair[0] !== undefined && pair[1] !== undefined) {
              pushPoint(bounds, pair[0], pair[1])
            }
          }
          break
        }

        if (curveTo3 !== undefined && operator === curveTo3) {
          const pairs = [
            [args[cursor], args[cursor + 1]],
            [args[cursor + 2], args[cursor + 3]],
          ]
          cursor += 4

          for (const pair of pairs) {
            if (pair[0] !== undefined && pair[1] !== undefined) {
              pushPoint(bounds, pair[0], pair[1])
            }
          }
          break
        }
      }
    }
  }

  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)) {
    return null
  }

  return bounds
}

async function extractTextElements(
  page: PDFPageProxy,
  pageNumber: number,
): Promise<ElementRecord[]> {
  const viewport = page.getViewport({ scale: 1 })
  const textContent = await page.getTextContent()
  const records: ElementRecord[] = []

  let index = 0
  for (const item of textContent.items) {
    if (!isTextItemLike(item) || item.str.trim().length === 0) {
      continue
    }

    const textHeightLike = item.transform[3]
    const tx = item.transform[4]
    const ty = item.transform[5]
    const width = Math.max(1, item.width)
    const height = Math.max(1, item.height || Math.abs(textHeightLike))
    const bbox = viewportRectToBox(viewport, tx, ty, tx + width, ty + height)

    records.push({
      id: `p${pageNumber}-text-${index}`,
      type: 'text',
      page: pageNumber,
      bbox,
      displayText: item.str,
      tags: [
        `font:${item.fontName ?? 'unknown'}`,
        `dir:${item.dir ?? 'unknown'}`,
        item.hasEOL ? 'eol:true' : 'eol:false',
      ],
      relations: [`page:${pageNumber}`],
      rawAttrs: {
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2)),
      },
    })

    index += 1
  }

  return records
}

async function extractPathElements(
  page: PDFPageProxy,
  pageNumber: number,
): Promise<ElementRecord[]> {
  const viewport = page.getViewport({ scale: 1 })
  const operatorList = await page.getOperatorList()
  const records: ElementRecord[] = []

  let index = 0
  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    if (operatorList.fnArray[i] !== OPS.constructPath) {
      continue
    }

    const pathArgs = operatorList.argsArray[i]
    if (!Array.isArray(pathArgs) || pathArgs.length < 2) {
      continue
    }

    const operatorsSource = pathArgs[0]
    const numbersSource = pathArgs[1]

    if (!Array.isArray(operatorsSource) || !Array.isArray(numbersSource)) {
      continue
    }

    const operators = operatorsSource.filter(
      (value): value is number => typeof value === 'number',
    )
    const numbers = numbersSource.filter(
      (value): value is number => typeof value === 'number',
    )

    const bounds = parsePathBounds(operators, numbers)
    if (!bounds) {
      continue
    }

    const bbox = viewportRectToBox(
      viewport,
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY,
    )

    const isLine = bbox.width <= 2 || bbox.height <= 2
    records.push({
      id: `p${pageNumber}-path-${index}`,
      type: isLine ? 'line' : 'path',
      page: pageNumber,
      bbox,
      displayText: isLine ? 'Line' : 'Path',
      tags: [isLine ? 'stroke' : 'shape', `ops:${operators.length}`],
      relations: [`page:${pageNumber}`, 'source:operator-list'],
      rawAttrs: {
        width: Number(bbox.width.toFixed(2)),
        height: Number(bbox.height.toFixed(2)),
      },
    })

    index += 1
  }

  return records
}

export async function analyzePdfDocument(
  pdfDoc: PDFDocumentProxy,
  onProgress?: ProgressCallback,
): Promise<AnalysisResult> {
  const elementsByPage: Record<number, ElementRecord[]> = {}
  let totalElements = 0

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    const page = await pdfDoc.getPage(pageNumber)
    const [textElements, pathElements] = await Promise.all([
      extractTextElements(page, pageNumber),
      extractPathElements(page, pageNumber),
    ])

    const merged = [...textElements, ...pathElements]
    elementsByPage[pageNumber] = merged
    totalElements += merged.length

    onProgress?.(pageNumber, pdfDoc.numPages)
  }

  return {
    elementsByPage,
    totalElements,
  }
}