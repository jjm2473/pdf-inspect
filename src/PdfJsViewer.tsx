import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MutableRefObject,
} from 'react'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import * as pdfjsLib from 'pdfjs-dist'
import type {
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import './PdfJsViewer.css'

type PdfJsViewerProps = {
  fileData: Uint8Array | null
  onError?: (message: string) => void
  onLoadingChange?: (loading: boolean) => void
  onLoadingProgress?: (loaded: number, total: number | null) => void
  onPageChange?: (pageNumber: number, totalPages: number) => void
  onScaleChange?: (scale: number) => void
}

export type PdfSearchResult = {
  id: string
  page: number
  matchIndex: number
  text: string
}

export type PdfJsViewerHandle = {
  prevPage: () => void
  nextPage: () => void
  goToPage: (pageNumber: number) => void
  setScale: (scale: number) => void
  getScale: () => number
  getCurrentPage: () => number
  getPagesCount: () => number
  find: (
    query: string,
    options?: {
      caseSensitive?: boolean
    },
  ) => void
  findNext: () => void
  findPrevious: () => void
  clearFind: () => void
  searchAll: (
    query: string,
    options?: {
      caseSensitive?: boolean
    },
  ) => Promise<PdfSearchResult[]>
  focusSearchResult: (result: PdfSearchResult) => Promise<void>
}

type ViewerWithNullableSetDocument = PDFViewer & {
  setDocument: (doc: PDFDocumentProxy | null) => void
}

type FindControllerWithNullableSetDocument = PDFFindController & {
  setDocument: (doc: PDFDocumentProxy | null) => void
}

function setViewerDocument(viewer: PDFViewer, doc: PDFDocumentProxy | null) {
  ;(viewer as ViewerWithNullableSetDocument).setDocument(doc)
}

function setFindDocument(
  findController: PDFFindController,
  doc: PDFDocumentProxy | null,
) {
  ;(findController as FindControllerWithNullableSetDocument).setDocument(doc)
}

function normalizeWheelEventDirection(evt: WheelEvent) {
  let delta = Math.hypot(evt.deltaX, evt.deltaY)
  const angle = Math.atan2(evt.deltaY, evt.deltaX)
  if (-0.25 * Math.PI < angle && angle < 0.75 * Math.PI) {
    delta = -delta
  }
  return delta
}

function accumulateTicks(ref: MutableRefObject<number>, ticks: number) {
  if ((ref.current > 0 && ticks < 0) || (ref.current < 0 && ticks > 0)) {
    ref.current = 0
  }
  ref.current += ticks
  const wholeTicks = Math.trunc(ref.current)
  ref.current -= wholeTicks
  return wholeTicks
}

function accumulateFactor(
  previousScale: number,
  factor: number,
  ref: MutableRefObject<number>
) {
  if (factor === 1) {
    return 1
  }
  if ((ref.current > 1 && factor < 1) || (ref.current < 1 && factor > 1)) {
    ref.current = 1
  }
  const newFactor =
    Math.floor(previousScale * factor * ref.current * 100) / (100 * previousScale)
  ref.current = factor / newFactor
  return newFactor
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function collectHighlightGroups(textLayer: Element) {
  const nodes = Array.from(textLayer.querySelectorAll('.highlight')) as HTMLElement[]
  const groups: HTMLElement[][] = []

  for (const node of nodes) {
    const isMiddle = node.classList.contains('middle')
    const isEnd = node.classList.contains('end')
    if (!isMiddle && !isEnd) {
      groups.push([node])
      continue
    }
    if (groups.length === 0) {
      continue
    }
    groups[groups.length - 1].push(node)
  }

  return groups
}

function buildSnippet(content: string, start: number, length: number) {
  const from = Math.max(0, start - 18)
  const to = Math.min(content.length, start + length + 26)
  const head = from > 0 ? '...' : ''
  const tail = to < content.length ? '...' : ''
  return `${head}${content.slice(from, to)}${tail}`.replace(/\s+/g, ' ').trim()
}

function toNormalizedIndex(
  diffs: [Uint32Array, Int32Array] | null | undefined,
  originalPos: number,
) {
  if (!diffs) {
    return originalPos
  }

  const [starts, shifts] = diffs
  const last = starts.length - 1

  for (let i = 0; i < last; i += 1) {
    const normStart = starts[i]
    const normEnd = starts[i + 1] - 1
    const shift = shifts[i]
    const oldStart = normStart + shift
    const oldEnd = normEnd + shift

    if (originalPos >= oldStart && originalPos <= oldEnd) {
      return originalPos - shift
    }
    if (originalPos < oldStart) {
      return normStart
    }
  }

  return originalPos - shifts[last]
}

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const PdfJsViewer = forwardRef<PdfJsViewerHandle, PdfJsViewerProps>(
  function PdfJsViewer(
    {
      fileData,
      onError,
      onLoadingChange,
      onLoadingProgress,
      onPageChange,
      onScaleChange,
    }: PdfJsViewerProps,
    ref,
  ) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const linkServiceRef = useRef<PDFLinkService | null>(null)
  const findControllerRef = useRef<PDFFindController | null>(null)
  const eventBusRef = useRef<
    | {
        dispatch: (eventName: string, payload: Record<string, unknown>) => void
        _on: (
          eventName: string,
          listener: (payload: Record<string, unknown>) => void,
        ) => void
      }
    | null
  >(null)
  const initPromiseRef = useRef<Promise<void> | null>(null)
  const wheelUnusedTicksRef = useRef(0)
  const wheelUnusedFactorRef = useRef(1)
  const isCtrlKeyDownRef = useRef(false)
  const findStateRef = useRef({
    query: '',
    caseSensitive: false,
  })

  useImperativeHandle(ref, () => ({
    prevPage: () => {
      pdfViewerRef.current?.previousPage()
    },
    nextPage: () => {
      pdfViewerRef.current?.nextPage()
    },
    goToPage: (pageNumber: number) => {
      const viewer = pdfViewerRef.current
      if (!viewer || !Number.isInteger(pageNumber)) {
        return
      }
      viewer.currentPageNumber = pageNumber
    },
    setScale: (scale: number) => {
      const viewer = pdfViewerRef.current
      if (!viewer || !Number.isFinite(scale)) {
        return
      }
      viewer.currentScale = scale
    },
    getScale: () => {
      return pdfViewerRef.current?.currentScale ?? 1
    },
    getCurrentPage: () => {
      return pdfViewerRef.current?.currentPageNumber ?? 1
    },
    getPagesCount: () => {
      return pdfViewerRef.current?.pagesCount ?? 0
    },
    find: (
      query: string,
      options: { caseSensitive?: boolean } = {},
    ) => {
      const eventBus = eventBusRef.current
      if (!eventBus) {
        return
      }

      const caseSensitive = options.caseSensitive ?? false
      findStateRef.current = { query, caseSensitive }

      eventBus.dispatch('find', {
        source: 'pdf-inspect',
        type: '',
        query,
        phraseSearch: true,
        caseSensitive,
        entireWord: false,
        highlightAll: true,
        findPrevious: false,
        matchDiacritics: false,
      })
    },
    findNext: () => {
      const eventBus = eventBusRef.current
      if (!eventBus || !findStateRef.current.query) {
        return
      }

      eventBus.dispatch('find', {
        source: 'pdf-inspect',
        type: 'again',
        query: findStateRef.current.query,
        phraseSearch: true,
        caseSensitive: findStateRef.current.caseSensitive,
        entireWord: false,
        highlightAll: true,
        findPrevious: false,
        matchDiacritics: false,
      })
    },
    findPrevious: () => {
      const eventBus = eventBusRef.current
      if (!eventBus || !findStateRef.current.query) {
        return
      }

      eventBus.dispatch('find', {
        source: 'pdf-inspect',
        type: 'again',
        query: findStateRef.current.query,
        phraseSearch: true,
        caseSensitive: findStateRef.current.caseSensitive,
        entireWord: false,
        highlightAll: true,
        findPrevious: true,
        matchDiacritics: false,
      })
    },
    clearFind: () => {
      const eventBus = eventBusRef.current
      if (!eventBus) {
        return
      }

      findStateRef.current = {
        query: '',
        caseSensitive: false,
      }
      eventBus.dispatch('find', {
        source: 'pdf-inspect',
        type: '',
        query: '',
        phraseSearch: true,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: false,
        matchDiacritics: false,
      })
    },
    searchAll: async (
      query: string,
      options: { caseSensitive?: boolean } = {},
    ) => {
      const eventBus = eventBusRef.current
      const findController = findControllerRef.current
      if (!eventBus || !findController) {
        return []
      }

      const caseSensitive = options.caseSensitive ?? false
      findStateRef.current = { query, caseSensitive }

      eventBus.dispatch('find', {
        source: 'pdf-inspect',
        type: 'again',
        query,
        phraseSearch: true,
        caseSensitive,
        entireWord: false,
        highlightAll: true,
        findPrevious: false,
        matchDiacritics: false,
      })

      const internal = findController as unknown as {
        _extractTextPromises?: Array<Promise<void>>
        _pendingFindMatches?: Set<number>
        _pageContents?: string[]
        _pageDiffs?: Array<[Uint32Array, Int32Array] | null>
      }

      // In PDF.js, plain find requests are delayed by FIND_TIMEOUT.
      // Wait one tick-window to ensure extraction/matching has started.
      await sleep(280)

      const textPromises = internal._extractTextPromises ?? []
      if (textPromises.length > 0) {
        await Promise.all(textPromises)
      }

      for (let attempt = 0; attempt < 120; attempt += 1) {
        const pendingSize = internal._pendingFindMatches?.size ?? 0
        if (pendingSize === 0) {
          break
        }
        await sleep(16)
      }

      const pageMatches = findController.pageMatches ?? []
      const pageMatchesLength = findController.pageMatchesLength ?? []
      const pageContents = internal._pageContents ?? []
      const pageDiffs = internal._pageDiffs ?? []
      const results: PdfSearchResult[] = []

      for (let pageIdx = 0; pageIdx < pageMatches.length; pageIdx += 1) {
        const matches = pageMatches[pageIdx] ?? []
        const lengths = pageMatchesLength[pageIdx] ?? []
        const content = pageContents[pageIdx] ?? ''
        const diffs = pageDiffs[pageIdx]
        for (let matchIdx = 0; matchIdx < matches.length; matchIdx += 1) {
          const start = matches[matchIdx] ?? 0
          const length = lengths[matchIdx] ?? query.length
          const normalizedStart = toNormalizedIndex(diffs, start)
          const snippetStart = Math.max(0, normalizedStart)
          results.push({
            id: `p${pageIdx + 1}-m${matchIdx}`,
            page: pageIdx + 1,
            matchIndex: matchIdx,
            text: buildSnippet(content, snippetStart, query.length || length),
          })
        }
      }

      return results
    },
    focusSearchResult: async (result: PdfSearchResult) => {
      const viewer = pdfViewerRef.current
      const container = containerRef.current
      if (!viewer || !container) {
        return
      }

      const isSamePage = viewer.currentPageNumber === result.page
      if (!isSamePage) {
        viewer.currentPageNumber = result.page
      }
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await sleep(16)
        const page = container.querySelector(
          `.page[data-page-number="${result.page}"] .textLayer`,
        )
        if (!page) {
          continue
        }
        const groups = collectHighlightGroups(page)
        const targetGroup = groups[result.matchIndex]
        const target = targetGroup?.[0]
        if (target) {
          for (const selected of page.querySelectorAll('.highlight.selected')) {
            selected.classList.remove('selected')
          }
          for (const node of targetGroup) {
            node.classList.add('selected')
          }
          target.scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: isSamePage ? 'smooth' : 'auto',
          })
          break
        }
      }
    },
  }), [])

  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    if (!container || !viewer) {
      return
    }

    let disposed = false
    initPromiseRef.current = (async () => {
      ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib

      const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await import(
        'pdfjs-dist/web/pdf_viewer.mjs'
      )
      if (disposed) {
        return
      }

      const eventBus = new EventBus()
      const linkService = new PDFLinkService({ eventBus })
      const findController = new PDFFindController({
        eventBus,
        linkService,
        updateMatchesCountOnProgress: true,
      })
      const pdfViewer = new PDFViewer({
        container,
        viewer,
        eventBus,
        linkService,
        findController,
        textLayerMode: 1,
        maxCanvasPixels: 2 ** 25,
        maxCanvasDim: 32767,
        capCanvasAreaFactor: 200,
        enableDetailCanvas: true,
        enableOptimizedPartialRendering: false,
        minDurationToUpdateCanvas: 500,
        supportsPinchToZoom: true,
      })

      const handleWheelZoom = (event: WheelEvent) => {
        if (pdfViewer.isInPresentationMode) {
          return
        }

        const deltaMode = event.deltaMode
        let scaleFactor = Math.exp(-event.deltaY / 100)
        const isBuiltInMac = false
        const isPinchToZoom =
          event.ctrlKey &&
          !isCtrlKeyDownRef.current &&
          deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
          event.deltaX === 0 &&
          (Math.abs(scaleFactor - 1) < 0.05 || isBuiltInMac) &&
          event.deltaZ === 0

        if (!(isPinchToZoom || event.ctrlKey || event.metaKey)) {
          return
        }

        event.preventDefault()
        const rect = container.getBoundingClientRect()
        const cursorLeft = event.clientX - rect.left
        const cursorTop = event.clientY - rect.top
        const origin = [cursorLeft, cursorTop]

        if (isPinchToZoom) {
          scaleFactor = accumulateFactor(
            pdfViewer.currentScale,
            scaleFactor,
            wheelUnusedFactorRef
          )
          pdfViewer.updateScale({
            drawingDelay: 400,
            scaleFactor,
            origin,
          })
          return
        }

        const delta = normalizeWheelEventDirection(event)
        let ticks = 0
        if (
          deltaMode === WheelEvent.DOM_DELTA_LINE ||
          deltaMode === WheelEvent.DOM_DELTA_PAGE
        ) {
          ticks =
            Math.abs(delta) >= 1
              ? Math.sign(delta)
              : accumulateTicks(wheelUnusedTicksRef, delta)
        } else {
          const PIXELS_PER_LINE_SCALE = 30
          ticks = accumulateTicks(
            wheelUnusedTicksRef,
            delta / PIXELS_PER_LINE_SCALE
          )
        }

        if (ticks !== 0) {
          pdfViewer.updateScale({
            drawingDelay: 400,
            steps: ticks,
            origin,
          })
        }
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        isCtrlKeyDownRef.current = event.key === 'Control'
      }

      const handleKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Control') {
          isCtrlKeyDownRef.current = false
        }
      }

      container.addEventListener('wheel', handleWheelZoom, { passive: false })
      window.addEventListener('keydown', handleKeyDown)
      window.addEventListener('keyup', handleKeyUp)

      linkService.setViewer(pdfViewer)
      pdfViewerRef.current = pdfViewer
      linkServiceRef.current = linkService
      findControllerRef.current = findController
      eventBusRef.current = eventBus

      eventBus._on('pagechanging', (payload: Record<string, unknown>) => {
        const pageNumber = Number(payload.pageNumber)
        const totalPages = pdfViewer.pagesCount
        if (Number.isInteger(pageNumber)) {
          onPageChange?.(pageNumber, totalPages)
        }
      })

      eventBus._on('scalechanging', (payload: Record<string, unknown>) => {
        const scale = Number(payload.scale)
        if (Number.isFinite(scale)) {
          onScaleChange?.(scale)
        }
      })

      eventBus._on('pagesinit', () => {
        onPageChange?.(pdfViewer.currentPageNumber, pdfViewer.pagesCount)
      })

      onError?.('')

      if (disposed) {
        container.removeEventListener('wheel', handleWheelZoom)
        window.removeEventListener('keydown', handleKeyDown)
        window.removeEventListener('keyup', handleKeyUp)
      }

      ;(
        pdfViewerRef.current as unknown as {
          __handleWheelZoom?: (event: WheelEvent) => void
          __handleKeyDown?: (event: KeyboardEvent) => void
          __handleKeyUp?: (event: KeyboardEvent) => void
        }
      ).__handleWheelZoom = handleWheelZoom
      ;(
        pdfViewerRef.current as unknown as {
          __handleWheelZoom?: (event: WheelEvent) => void
          __handleKeyDown?: (event: KeyboardEvent) => void
          __handleKeyUp?: (event: KeyboardEvent) => void
        }
      ).__handleKeyDown = handleKeyDown
      ;(
        pdfViewerRef.current as unknown as {
          __handleWheelZoom?: (event: WheelEvent) => void
          __handleKeyDown?: (event: KeyboardEvent) => void
          __handleKeyUp?: (event: KeyboardEvent) => void
        }
      ).__handleKeyUp = handleKeyUp
    })()

    void initPromiseRef.current.catch((error) => {
      const message =
        error instanceof Error
          ? `初始化阅读器失败: ${error.message}`
          : '初始化阅读器失败'
      console.error('[PdfJsViewer] init failed', error)
      onError?.(message)
    })

    return () => {
      disposed = true
      const pdfViewer = pdfViewerRef.current
      const linkService = linkServiceRef.current
      const wheelHandler = (
        pdfViewer as unknown as {
          __handleWheelZoom?: (event: WheelEvent) => void
          __handleKeyDown?: (event: KeyboardEvent) => void
          __handleKeyUp?: (event: KeyboardEvent) => void
        } | null
      )?.__handleWheelZoom
      const keyDownHandler = (
        pdfViewer as unknown as {
          __handleWheelZoom?: (event: WheelEvent) => void
          __handleKeyDown?: (event: KeyboardEvent) => void
          __handleKeyUp?: (event: KeyboardEvent) => void
        } | null
      )?.__handleKeyDown
      const keyUpHandler = (
        pdfViewer as unknown as {
          __handleWheelZoom?: (event: WheelEvent) => void
          __handleKeyDown?: (event: KeyboardEvent) => void
          __handleKeyUp?: (event: KeyboardEvent) => void
        } | null
      )?.__handleKeyUp
      if (wheelHandler) {
        container.removeEventListener('wheel', wheelHandler)
      }
      if (keyDownHandler) {
        window.removeEventListener('keydown', keyDownHandler)
      }
      if (keyUpHandler) {
        window.removeEventListener('keyup', keyUpHandler)
      }
      if (pdfViewer) {
        setViewerDocument(pdfViewer, null)
      }
      linkService?.setDocument(null)
      pdfViewerRef.current = null
      linkServiceRef.current = null
      findControllerRef.current = null
      eventBusRef.current = null
      initPromiseRef.current = null
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let loadingTask: ReturnType<typeof getDocument> | null = null
    let currentDoc: PDFDocumentProxy | null = null

    const open = async () => {
      await initPromiseRef.current
      const pdfViewer = pdfViewerRef.current
      const linkService = linkServiceRef.current
      const findController = findControllerRef.current
      if (!pdfViewer || !linkService || !findController) {
        return
      }

      setViewerDocument(pdfViewer, null)
      linkService.setDocument(null)
      setFindDocument(findController, null)

      if (!fileData) {
        onLoadingChange?.(false)
        onError?.('')
        return
      }

      onLoadingChange?.(true)

      loadingTask = getDocument({
        data: fileData,
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/',
      })
      loadingTask.onProgress = ({ loaded, total }: { loaded: number; total?: number }) => {
        onLoadingProgress?.(loaded, total ?? null)
      }

      const pdfDoc = await loadingTask.promise
      if (disposed) {
        await pdfDoc.destroy()
        return
      }

      currentDoc = pdfDoc
      linkService.setDocument(pdfDoc)
      setFindDocument(findController, pdfDoc)
      pdfViewer.setDocument(pdfDoc)
      await pdfViewer.firstPagePromise
      if (disposed) {
        return
      }
      pdfViewer.currentScale = 1
      onPageChange?.(pdfViewer.currentPageNumber, pdfViewer.pagesCount)
      onScaleChange?.(pdfViewer.currentScale)
      onError?.('')
      onLoadingChange?.(false)
    }

    open().catch((error) => {
      const message =
        error instanceof Error
          ? `加载 PDF 失败: ${error.message}`
          : '加载 PDF 失败'
      console.error('[PdfJsViewer] open failed', error)
      onError?.(message)
      onLoadingChange?.(false)
    })

    return () => {
      disposed = true
      loadingTask?.destroy()
      if (currentDoc) {
        void currentDoc.destroy()
      }
      const pdfViewer = pdfViewerRef.current
      const linkService = linkServiceRef.current
      const findController = findControllerRef.current
      if (pdfViewer) {
        setViewerDocument(pdfViewer, null)
      }
      linkService?.setDocument(null)
      if (findController) {
        setFindDocument(findController, null)
      }
      onLoadingChange?.(false)
    }
  }, [fileData])

  return (
    <div ref={containerRef} className="pdfjs-container">
      <div ref={viewerRef} className="pdfViewer" />
    </div>
  )
})

export default PdfJsViewer
