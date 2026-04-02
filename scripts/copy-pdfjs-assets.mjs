import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..')

const sourceCmaps = resolve(rootDir, 'node_modules/pdfjs-dist/cmaps')
const sourceFonts = resolve(rootDir, 'node_modules/pdfjs-dist/standard_fonts')
const targetRoot = resolve(rootDir, 'public/pdfjs')
const targetCmaps = resolve(targetRoot, 'cmaps')
const targetFonts = resolve(targetRoot, 'standard_fonts')

if (!existsSync(sourceCmaps) || !existsSync(sourceFonts)) {
  throw new Error(
    'pdfjs-dist assets not found. Run npm install before copying PDF.js assets.',
  )
}

rmSync(targetCmaps, { recursive: true, force: true })
rmSync(targetFonts, { recursive: true, force: true })
mkdirSync(targetRoot, { recursive: true })

cpSync(sourceCmaps, targetCmaps, { recursive: true })
cpSync(sourceFonts, targetFonts, { recursive: true })

console.log('PDF.js assets prepared at public/pdfjs/')
