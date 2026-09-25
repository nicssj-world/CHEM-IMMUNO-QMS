import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb } from 'pdf-lib'
import { VENDOR_EVALUATION_CRITERION_LABELS, type Frozen } from '@/lib/vendor-evaluation'
import { ISSUE_RESOLUTION_LABELS, ISSUE_TYPE_LABELS } from '@/lib/vendor-issues'
import { REASON_LABELS } from '@/lib/receipt-assessment'

// Port of LABCBH-Stock lib/vendor-evaluation/annual-pdf.ts. Layout, fonts and wording are kept; data columns are mapped to
// CHEM-IMMUNO's Invoice-based evidence (Invoice / PO / receipt event) and the report is stamped with its warehouse.
export type AnnualPdfRevision = {
  status: 'draft' | 'final'; frozen: Frozen | null; reportNumber: string | null; finalizedAt: string | null; revisionNumber: number;
  policyApproved: boolean; warehouseName: string;
  evaluatorSignature: string | null; reviewerSignature: string | null; approverSignature: string | null;
}

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN_X = 32
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2
const CONTENT_TOP = 706
const CONTENT_BOTTOM = 50
const INK = rgb(0.08, 0.14, 0.22)
const MUTED = rgb(0.34, 0.4, 0.48)
const BLUE = rgb(0.12, 0.37, 0.68)
const BLUE_SOFT = rgb(0.88, 0.93, 0.98)
const TEAL = rgb(0.03, 0.46, 0.4)
const TEAL_SOFT = rgb(0.9, 0.97, 0.95)
const RED = rgb(0.76, 0.16, 0.16)
const RED_SOFT = rgb(0.99, 0.92, 0.91)
const BORDER = rgb(0.74, 0.79, 0.84)
const PAPER = rgb(0.97, 0.98, 0.99)
const WHITE = rgb(1, 1, 1)

type Align = 'left' | 'center' | 'right'
interface Column { header: string; width: number; align?: Align }
interface PageState { page: PDFPage; y: number }
interface ReportContext {
  reportNumber: string
  revisionNumber: number
  fiscalYear: number
  finalizedAt: string
  policyVersion: string
  generatedAt: string
  warehouseName: string
}

let regularFontBytes: Promise<Uint8Array> | null = null
let boldFontBytes: Promise<Uint8Array> | null = null

function loadFonts() {
  const directory = join(process.cwd(), 'node_modules', 'font-th-sarabun-new', 'fonts')
  regularFontBytes ??= readFile(join(directory, 'THSarabunNew-webfont.ttf'))
  boldFontBytes ??= readFile(join(directory, 'THSarabunNew_bold-webfont.ttf'))
  return Promise.all([regularFontBytes, boldFontBytes])
}

function text(value: unknown, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function numberLabel(value: unknown, fallback = 'N/A') {
  const parsed = numeric(value)
  return parsed === null ? fallback : new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(parsed)
}

function dateLabel(value: unknown) {
  if (typeof value !== 'string' || !value) return '—'
  const date = new Date(value.length === 10 ? `${value}T00:00:00+07:00` : value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('th-TH', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(date)
}

function dateTimeLabel(value: Date) {
  return new Intl.DateTimeFormat('th-TH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok',
  }).format(value)
}

function wrapAll(value: string, font: PDFFont, size: number, maxWidth: number) {
  const source = value.trim() || '—'
  const lines: string[] = []
  let line = ''
  for (const unit of [...source.replace(/\s+/g, ' ')]) {
    const candidate = line + unit
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line.trimEnd())
      line = unit.trim() ? unit : ''
    } else {
      line = candidate
    }
  }
  if (line || lines.length === 0) lines.push(line.trimEnd() || '—')
  return lines
}

function drawTextLines(page: PDFPage, lines: readonly string[], x: number, y: number, font: PDFFont, size: number, color = INK, lineHeight = size + 2) {
  lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, font, size, color }))
  return y - lines.length * lineHeight
}

function drawWrapped(page: PDFPage, value: string, x: number, y: number, width: number, font: PDFFont, size: number, color = INK, lineHeight = size + 2) {
  return drawTextLines(page, wrapAll(value, font, size, width), x, y, font, size, color, lineHeight)
}

function drawSubheading(page: PDFPage, title: string, y: number, bold: PDFFont) {
  return drawSubheadingAt(page, title, MARGIN_X, CONTENT_WIDTH, y, bold)
}

function drawSubheadingAt(page: PDFPage, title: string, x: number, width: number, y: number, bold: PDFFont) {
  page.drawText(title, { x, y, font: bold, size: 12, color: BLUE })
  page.drawLine({ start: { x, y: y - 5 }, end: { x: x + width, y: y - 5 }, color: BORDER, thickness: 0.65 })
  return y - 20
}

function drawPaginatedText(
  document: PDFDocument,
  state: PageState,
  continuationTitle: string,
  value: string,
  context: ReportContext,
  logo: PDFImage,
  regular: PDFFont,
  bold: PDFFont,
) {
  let page = state.page
  let y = state.y
  const lines = wrapAll(value, regular, 9.5, CONTENT_WIDTH - 4)
  while (lines.length > 0) {
    const availableLines = Math.floor((y - CONTENT_BOTTOM - 8) / 11.5)
    if (availableLines < 1) {
      const next = addReportPage(document, continuationTitle, context, logo, regular, bold)
      page = next.page
      y = drawSubheading(page, 'สรุปผู้บริหาร (ต่อ)', next.y, bold)
      continue
    }
    const chunk = lines.splice(0, availableLines)
    y = drawTextLines(page, chunk, MARGIN_X + 2, y, regular, 9.5, INK, 11.5) - 5
    if (lines.length > 0) {
      const next = addReportPage(document, continuationTitle, context, logo, regular, bold)
      page = next.page
      y = drawSubheading(page, 'สรุปผู้บริหาร (ต่อ)', next.y, bold)
    }
  }
  return { page, y }
}

function addReportPage(document: PDFDocument, sectionTitle: string, context: ReportContext, logo: PDFImage, regular: PDFFont, bold: PDFFont): PageState {
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  page.drawImage(logo, { x: MARGIN_X, y: 786, width: 43, height: 43 })
  page.drawText('โรงพยาบาลชลบุรี', { x: 84, y: 814, font: bold, size: 15, color: BLUE })
  page.drawText('Chonburi Hospital', { x: 84, y: 801, font: regular, size: 9, color: MUTED })
  page.drawText('กลุ่มงานเทคนิคการแพทย์', { x: 84, y: 787, font: bold, size: 10, color: INK })
  page.drawText('Department of Medical Technology', { x: 84, y: 775, font: regular, size: 8, color: MUTED })

  const metaX = 394
  const metaY = 774
  const metaW = PAGE_WIDTH - MARGIN_X - metaX
  const metaH = 62
  page.drawRectangle({ x: metaX, y: metaY, width: metaW, height: metaH, borderColor: BORDER, borderWidth: 0.7, color: WHITE })
  const meta = [
    `เลขที่รายงาน: ${context.reportNumber}`,
    `Revision: ${context.revisionNumber} · สถานะ: Final`,
    `วันที่สิ้นสุด: ${dateLabel(context.finalizedAt)}`,
    `คลัง: ${context.warehouseName}`,
    `Policy Version: ${context.policyVersion}`,
  ]
  meta.forEach((line, index) => page.drawText(line, { x: metaX + 7, y: metaY + metaH - 10 - index * 10.5, font: regular, size: 8.1, color: INK }))

  if (sectionTitle) {
    page.drawRectangle({ x: MARGIN_X, y: 738, width: CONTENT_WIDTH, height: 23, color: BLUE_SOFT })
    page.drawText(sectionTitle, { x: MARGIN_X + 8, y: 744, font: bold, size: 12.5, color: BLUE })
  }
  return { page, y: CONTENT_TOP }
}

function drawInlineTable(
  page: PDFPage,
  x: number,
  top: number,
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  regular: PDFFont,
  bold: PDFFont,
  fontSize = 8.2,
) {
  const width = columns.reduce((sum, column) => sum + column.width, 0)
  const headerHeight = 25
  page.drawRectangle({ x, y: top - headerHeight, width, height: headerHeight, color: BLUE_SOFT, borderColor: BORDER, borderWidth: 0.65 })
  let columnX = x
  columns.forEach((column, index) => {
    const lines = wrapAll(column.header, bold, fontSize, column.width - 7)
    const lineHeight = fontSize + 1
    const startY = top - Math.max(6, (headerHeight - lines.length * lineHeight) / 2) - fontSize
    lines.forEach((line, lineIndex) => {
      const measured = bold.widthOfTextAtSize(line, fontSize)
      const textX = column.align === 'right' ? columnX + column.width - measured - 4
        : column.align === 'center' ? columnX + (column.width - measured) / 2 : columnX + 4
      page.drawText(line, { x: textX, y: startY - lineIndex * lineHeight, font: bold, size: fontSize, color: BLUE })
    })
    columnX += column.width
    if (index < columns.length - 1) page.drawLine({ start: { x: columnX, y: top }, end: { x: columnX, y: top - headerHeight }, color: BORDER, thickness: 0.5 })
  })

  let y = top - headerHeight
  rows.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, index) => wrapAll(cell, regular, fontSize, columns[index].width - 7))
    const lineHeight = fontSize + 1
    const height = Math.max(22, Math.max(...wrapped.map((lines) => lines.length), 1) * lineHeight + 7)
    page.drawRectangle({ x, y: y - height, width, height, color: rowIndex % 2 ? PAPER : WHITE, borderColor: BORDER, borderWidth: 0.45 })
    columnX = x
    wrapped.forEach((lines, index) => {
      const column = columns[index]
      lines.forEach((line, lineIndex) => {
        const measured = regular.widthOfTextAtSize(line, fontSize)
        const textX = column.align === 'right' ? columnX + column.width - measured - 4
          : column.align === 'center' ? columnX + (column.width - measured) / 2 : columnX + 4
        page.drawText(line, { x: textX, y: y - 6 - fontSize - lineIndex * lineHeight, font: regular, size: fontSize, color: INK })
      })
      columnX += column.width
      if (index < columns.length - 1) page.drawLine({ start: { x: columnX, y }, end: { x: columnX, y: y - height }, color: BORDER, thickness: 0.4 })
    })
    y -= height
  })
  return y
}

function drawTableHeader(page: PDFPage, top: number, columns: readonly Column[], bold: PDFFont) {
  const height = 27
  page.drawRectangle({ x: MARGIN_X, y: top - height, width: CONTENT_WIDTH, height, color: BLUE_SOFT, borderColor: BORDER, borderWidth: 0.65 })
  let x = MARGIN_X
  columns.forEach((column, index) => {
    const lines = wrapAll(column.header, bold, 8.8, column.width - 8)
    const lineHeight = 9.5
    const startY = top - Math.max(7, (height - lines.length * lineHeight) / 2) - 7
    lines.forEach((line, lineIndex) => {
      const measured = bold.widthOfTextAtSize(line, 8.8)
      const tx = column.align === 'right' ? x + column.width - measured - 4
        : column.align === 'center' ? x + (column.width - measured) / 2 : x + 4
      page.drawText(line, { x: tx, y: startY - lineIndex * lineHeight, font: bold, size: 8.8, color: BLUE })
    })
    x += column.width
    if (index < columns.length - 1) page.drawLine({ start: { x, y: top }, end: { x, y: top - height }, color: BORDER, thickness: 0.55 })
  })
  return top - height
}

function drawTableSegment(page: PDFPage, top: number, lines: readonly (readonly string[])[], columns: readonly Column[], regular: PDFFont, index: number) {
  const fontSize = 8.5
  const lineHeight = 10.4
  const height = Math.max(24, Math.max(...lines.map((cell) => cell.length), 1) * lineHeight + 8)
  page.drawRectangle({ x: MARGIN_X, y: top - height, width: CONTENT_WIDTH, height, color: index % 2 ? PAPER : WHITE, borderColor: BORDER, borderWidth: 0.45 })
  let x = MARGIN_X
  lines.forEach((cellLines, columnIndex) => {
    const column = columns[columnIndex]
    cellLines.forEach((line, lineIndex) => {
      const measured = regular.widthOfTextAtSize(line, fontSize)
      const tx = column.align === 'right' ? x + column.width - measured - 4
        : column.align === 'center' ? x + (column.width - measured) / 2 : x + 4
      page.drawText(line, { x: tx, y: top - 7 - fontSize - lineIndex * lineHeight, font: regular, size: fontSize, color: INK })
    })
    x += column.width
    if (columnIndex < columns.length - 1) page.drawLine({ start: { x, y: top }, end: { x, y: top - height }, color: BORDER, thickness: 0.4 })
  })
  return top - height
}

function drawPaginatedTable(
  document: PDFDocument,
  state: PageState,
  continuationTitle: string,
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  context: ReportContext,
  logo: PDFImage,
  regular: PDFFont,
  bold: PDFFont,
  emptyText: string,
) {
  let page = state.page
  let y = drawTableHeader(page, state.y, columns, bold)
  const newPage = () => {
    const next = addReportPage(document, continuationTitle, context, logo, regular, bold)
    page = next.page
    y = drawTableHeader(page, next.y, columns, bold)
  }
  if (rows.length === 0) {
    page.drawText(emptyText, { x: MARGIN_X + 2, y: y - 19, font: regular, size: 10, color: MUTED })
    return { page, y: y - 34 }
  }

  rows.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, columnIndex) => wrapAll(cell, regular, 8.5, columns[columnIndex].width - 8))
    const maxLines = Math.max(...wrapped.map((lines) => lines.length))
    const fullHeight = Math.max(24, maxLines * 10.4 + 8)
    const freshBodyHeight = CONTENT_TOP - 27 - CONTENT_BOTTOM
    if (fullHeight <= freshBodyHeight && y - fullHeight < CONTENT_BOTTOM) newPage()
    let offset = 0
    let segmentIndex = 0
    while (offset < maxLines) {
      const availableLines = Math.floor((y - CONTENT_BOTTOM - 8) / 10.4)
      if (availableLines < 1) {
        newPage()
        continue
      }
      const segmentSize = Math.min(maxLines - offset, availableLines)
      const segment = wrapped.map((cellLines) => cellLines.slice(offset, offset + segmentSize))
      if (segmentIndex > 0 && segment[0].length === 0) segment[0] = [`${text(row[0])} (ต่อ)`]
      const segmentHeight = Math.max(24, Math.max(...segment.map((cell) => cell.length), 1) * 10.4 + 8)
      if (y - segmentHeight < CONTENT_BOTTOM) {
        newPage()
        continue
      }
      y = drawTableSegment(page, y, segment, columns, regular, rowIndex + segmentIndex)
      offset += segmentSize
      segmentIndex += 1
      if (offset < maxLines) newPage()
    }
  })
  return { page, y: y - 4 }
}

function criterionLabel(code: unknown, provided: unknown) {
  if (typeof provided === 'string' && provided.trim()) return provided
  if (typeof code === 'string' && code in VENDOR_EVALUATION_CRITERION_LABELS) {
    return VENDOR_EVALUATION_CRITERION_LABELS[code as keyof typeof VENDOR_EVALUATION_CRITERION_LABELS]
  }
  return text(code)
}

const ASSESSMENT_LABELS: Record<string, string> = {
  productCondition: 'สภาพสินค้า', documentation: 'เอกสาร', itemCorrectness: 'รายการ',
  coldChainCondition: 'อุณหภูมิ', hasComplaint: 'ข้อร้องเรียน',
}

const ANSWER_LABELS: Record<string, string> = {
  normal: 'ปกติ', abnormal: 'ผิดปกติ', complete: 'ครบถ้วน', incomplete: 'ไม่ครบถ้วน', correct: 'ถูกต้อง', problem: 'พบปัญหา',
  appropriate: 'เหมาะสม', inappropriate: 'ไม่เหมาะสม',
}
const answer = (value: unknown) => ANSWER_LABELS[text(value, '')] ?? text(value)

function exceptionLabels(assessment: Record<string, unknown>) {
  const labels: string[] = []
  if (assessment.productCondition === 'abnormal') labels.push('สภาพสินค้า: ผิดปกติ')
  if (assessment.documentation === 'incomplete') labels.push('เอกสาร: ไม่ครบถ้วน')
  if (assessment.itemCorrectness === 'problem') labels.push('รายการ: พบปัญหา')
  if (assessment.coldChainApplicable === true && assessment.coldChainCondition === 'inappropriate') labels.push('อุณหภูมิ: ไม่เหมาะสม')
  if (assessment.hasComplaint === true) labels.push('มีข้อร้องเรียน')
  const reasons = Array.isArray(assessment.reasons) ? assessment.reasons : []
  for (const code of reasons) {
    if (typeof code !== 'string' || !code) continue
    const label = (REASON_LABELS as Record<string, string>)[code] ?? code
    labels.push(code === 'other' && assessment.otherReasonDetail ? `${label}: ${text(assessment.otherReasonDetail)}` : label)
  }
  return labels
}

function drawDonut(page: PDFPage, x: number, y: number, radius: number, completed: number, pending: number, bold: PDFFont, regular: PDFFont) {
  const total = completed + pending
  const covered = total === 0 ? 0 : Math.max(0, Math.min(1, completed / total))
  const segments = 120
  for (let index = 0; index < segments; index += 1) {
    const start = (index / segments) * Math.PI * 2 - Math.PI / 2
    const end = ((index + 0.78) / segments) * Math.PI * 2 - Math.PI / 2
    const ratio = index / segments
    const color = ratio < covered ? TEAL : BORDER
    page.drawLine({
      start: { x: x + Math.cos(start) * radius, y: y + Math.sin(start) * radius },
      end: { x: x + Math.cos(end) * radius, y: y + Math.sin(end) * radius },
      color, thickness: 6,
    })
  }
  const value = total === 0 ? 'N/A' : `${completed} / ${total}`
  const valueWidth = bold.widthOfTextAtSize(value, 13)
  page.drawText(value, { x: x - valueWidth / 2, y: y + 1, font: bold, size: 13, color: BLUE })
  const percent = total === 0 ? 'ไม่มีข้อมูล' : `${numberLabel(covered * 100, 'N/A')}%`
  const percentWidth = regular.widthOfTextAtSize(percent, 8.5)
  page.drawText(percent, { x: x - percentWidth / 2, y: y - 12, font: regular, size: 8.5, color: MUTED })
}

function drawCriteriaBars(page: PDFPage, criteria: readonly Record<string, unknown>[], y: number, regular: PDFFont, bold: PDFFont, x = MARGIN_X, width = CONTENT_WIDTH) {
  let cursor = drawSubheadingAt(page, '4.2 ผลตามเกณฑ์', x, width, y, bold)
  const labelWidth = Math.round(width * 0.43)
  const barX = x + labelWidth
  const barWidth = width - labelWidth - 37
  const valueX = barX + barWidth + 6
  const rowHeight = 18.5
  criteria.forEach((criterion) => {
    const label = `${numberLabel(criterion.displayOrder, '')}. ${criterionLabel(criterion.criterionCode, criterion.label)}`
    const lines = wrapAll(label, regular, 8, labelWidth - 8)
    drawTextLines(page, lines.slice(0, 2), x + 2, cursor, regular, 8, INK, 8.4)
    const percent = numeric(criterion.percentage)
    page.drawRectangle({ x: barX, y: cursor - 3, width: barWidth, height: 9, color: PAPER, borderColor: BORDER, borderWidth: 0.35 })
    if (percent !== null && percent > 0) {
      const normalized = Math.max(0, Math.min(100, percent))
      const fillColor = numeric(criterion.numerator) !== null && numeric(criterion.denominator) !== null
        && Number(criterion.numerator) < Number(criterion.denominator) ? RED : BLUE
      page.drawRectangle({ x: barX, y: cursor - 3, width: barWidth * normalized / 100, height: 9, color: fillColor })
    }
    const result = percent === null ? 'N/A' : `${numberLabel(percent)}%`
    page.drawText(result, { x: valueX, y: cursor - 1, font: bold, size: 8, color: percent !== null && percent < 100 ? RED : BLUE })
    cursor -= rowHeight
  })
  return cursor - 3
}

function monthNumber(value: unknown) {
  if (typeof value !== 'string') return null
  const month = value.length > 10 ? Number(new Intl.DateTimeFormat('en-GB', { month: 'numeric', timeZone: 'Asia/Bangkok' }).format(new Date(value))) : Number(value.slice(5, 7))
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null
}

function drawMonthlyChart(page: PDFPage, receipts: readonly Record<string, unknown>[], issues: readonly Record<string, unknown>[], y: number, regular: PDFFont, bold: PDFFont) {
  const cursor = drawSubheading(page, '4.4 แนวโน้มรายการรับและปัญหารายเดือน', y, bold)
  const months = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  const receiptCounts = new Map(months.map((month) => [month, 0]))
  const issueCounts = new Map(months.map((month) => [month, 0]))
  receipts.forEach((receipt) => {
    const month = monthNumber(receipt.receivedDate)
    if (month !== null) receiptCounts.set(month, (receiptCounts.get(month) ?? 0) + 1)
  })
  issues.forEach((issue) => {
    const month = monthNumber(issue.openedAt)
    if (month !== null) issueCounts.set(month, (issueCounts.get(month) ?? 0) + 1)
  })
  const total = [...receiptCounts.values(), ...issueCounts.values()].reduce((sum, value) => sum + value, 0)
  if (total === 0) {
    page.drawText('ไม่มีรายการรับหรือปัญหาใน Snapshot สำหรับช่วงรายงานนี้', { x: MARGIN_X + 3, y: cursor - 3, font: regular, size: 9, color: MUTED })
    return cursor - 19
  }
  const chartWidth = CONTENT_WIDTH
  const chartHeight = 66
  const baseY = cursor - chartHeight
  const maxValue = Math.max(1, ...receiptCounts.values(), ...issueCounts.values())
  const slot = chartWidth / months.length
  months.forEach((month, index) => {
    const x = MARGIN_X + slot * index + slot / 2
    const receiptValue = receiptCounts.get(month) ?? 0
    const issueValue = issueCounts.get(month) ?? 0
    const barWidth = Math.min(9, slot * 0.22)
    const receiptHeight = receiptValue / maxValue * 43
    const issueHeight = issueValue / maxValue * 43
    if (receiptHeight > 0) page.drawRectangle({ x: x - barWidth - 1, y: baseY, width: barWidth, height: receiptHeight, color: BLUE })
    if (issueHeight > 0) page.drawRectangle({ x: x + 1, y: baseY, width: barWidth, height: issueHeight, color: RED })
    const labelDate = new Date(Date.UTC(2020, month - 1, 1))
    const label = new Intl.DateTimeFormat('th-TH', { month: 'short', timeZone: 'UTC' }).format(labelDate)
    const labelWidth = regular.widthOfTextAtSize(label, 7.2)
    page.drawText(label, { x: x - labelWidth / 2, y: baseY - 11, font: regular, size: 7.2, color: MUTED })
  })
  page.drawLine({ start: { x: MARGIN_X, y: baseY }, end: { x: MARGIN_X + chartWidth, y: baseY }, color: BORDER, thickness: 0.6 })
  const legendY = baseY - 24
  page.drawRectangle({ x: MARGIN_X + 5, y: legendY + 2, width: 8, height: 8, color: BLUE })
  page.drawText('รายการรับของ', { x: MARGIN_X + 17, y: legendY + 2, font: regular, size: 8, color: MUTED })
  page.drawRectangle({ x: MARGIN_X + 104, y: legendY + 2, width: 8, height: 8, color: RED })
  page.drawText('ปัญหาที่บันทึก', { x: MARGIN_X + 116, y: legendY + 2, font: regular, size: 8, color: MUTED })
  return legendY - 1
}

function assessmentSummaryRows(assessments: readonly Record<string, unknown>[]) {
  const completed = assessments
  const count = (predicate: (assessment: Record<string, unknown>) => boolean) => completed.filter(predicate).length
  const total = String(completed.length)
  if (completed.length === 0) {
    return [
      ['สภาพสินค้า', 'N/A', 'N/A', 'N/A', total], ['เอกสารประกอบ', 'N/A', 'N/A', 'N/A', total],
      ['ความถูกต้องของรายการ', 'N/A', 'N/A', 'N/A', total], ['การควบคุมอุณหภูมิ', 'N/A', 'N/A', 'N/A', total],
      ['ข้อร้องเรียน', 'N/A', 'N/A', 'N/A', total], ['ผลการรับ', 'N/A', 'N/A', 'N/A', total],
    ]
  }
  return [
    ['สภาพสินค้า', String(count((a) => a.productCondition === 'normal')), String(count((a) => a.productCondition === 'abnormal')), '0', total],
    ['เอกสารประกอบ', String(count((a) => a.documentation === 'complete')), String(count((a) => a.documentation === 'incomplete')), '0', total],
    ['ความถูกต้องของรายการ', String(count((a) => a.itemCorrectness === 'correct')), String(count((a) => a.itemCorrectness === 'problem')), '0', total],
    ['การควบคุมอุณหภูมิ', String(count((a) => a.coldChainApplicable === true && a.coldChainCondition === 'appropriate')), String(count((a) => a.coldChainApplicable === true && a.coldChainCondition === 'inappropriate')), String(count((a) => a.coldChainApplicable === false)), total],
    ['ข้อร้องเรียน', String(count((a) => a.hasComplaint === false)), String(count((a) => a.hasComplaint === true)), '0', total],
    ['ผลการรับ', String(count((a) => a.acceptanceDecision === 'accepted')), String(count((a) => a.acceptanceDecision === 'accepted_with_justification')), '0', total],
  ]
}

async function embedSignature(document: PDFDocument, dataUri: string | null, role: string): Promise<PDFImage> {
  if (!dataUri?.startsWith('data:image/png;base64,')) throw new Error(`ไม่พบลายเซ็น ${role} ในรายงานที่ตรึงแล้ว`)
  try {
    return await document.embedPng(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64'))
  } catch {
    throw new Error(`ลายเซ็น ${role} ในรายงานที่ตรึงแล้วไม่ถูกต้อง`)
  }
}

function drawSignature(page: PDFPage, x: number, y: number, width: number, role: string, name: string, position: string, image: PDFImage, regular: PDFFont, bold: PDFFont) {
  const scale = Math.min(width / image.width, 45 / image.height)
  const imageWidth = image.width * scale
  const imageHeight = image.height * scale
  page.drawImage(image, { x: x + (width - imageWidth) / 2, y: y + 67 - imageHeight, width: imageWidth, height: imageHeight })
  page.drawLine({ start: { x: x + 5, y: y + 17 }, end: { x: x + width - 5, y: y + 17 }, color: BORDER, thickness: 0.7 })
  const safeName = text(name)
  const nameWidth = bold.widthOfTextAtSize(safeName, 9.5)
  page.drawText(safeName, { x: x + Math.max(0, (width - nameWidth) / 2), y: y + 4, font: bold, size: 9.5, color: INK })
  const roleLabel = `${role} · ${text(position)}`
  const roleLines = wrapAll(roleLabel, regular, 8, width - 8)
  drawTextLines(page, roleLines, x + 4, y - 9, regular, 8, MUTED, 9)
  page.drawText('วันที่ลงนาม: —', { x: x + 4, y: y - 28, font: regular, size: 7.5, color: MUTED })
}

export async function generateVendorAnnualEvaluationPdf(revision: AnnualPdfRevision): Promise<Uint8Array> {
  if (revision.status !== 'final' || !revision.frozen || !revision.reportNumber || !revision.finalizedAt) {
    throw new Error('ดาวน์โหลด PDF ได้เฉพาะรายงานที่สิ้นสุดและตรึงข้อมูลแล้ว')
  }
  if (!revision.policyApproved) throw new Error('รายงานอย่างเป็นทางการต้องใช้นโยบายที่อนุมัติแล้ว')
  if (revision.frozen.reportNumber !== revision.reportNumber || revision.frozen.revision !== revision.revisionNumber) {
    throw new Error('ข้อมูลอ้างอิงของรายงานที่ตรึงไว้ไม่ตรงกับ revision')
  }

  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const [regularBytes, boldBytes] = await loadFonts()
  const [regular, bold] = await Promise.all([
    document.embedFont(regularBytes, { subset: true }),
    document.embedFont(boldBytes, { subset: true }),
  ])
  const [logo, evaluatorSignature, reviewerSignature, approverSignature] = await Promise.all([
    document.embedPng(await readFile(join(process.cwd(), 'public', 'images', 'cbh-lab-logo-v3.png'))),
    embedSignature(document, revision.evaluatorSignature, 'ผู้ประเมิน'),
    embedSignature(document, revision.reviewerSignature, 'ผู้ทบทวน'),
    embedSignature(document, revision.approverSignature, 'ผู้อนุมัติ'),
  ])

  const frozen = revision.frozen
  const evidence = frozen.evidence
  const vendor = evidence.vendor
  const activity = evidence.activity
  const receipts = (evidence.receipts ?? []) as unknown as Array<Record<string, unknown>>
  const assessments = (evidence.assessments ?? []) as unknown as Array<Record<string, unknown>>
  const issues = (evidence.issues ?? []) as unknown as Array<Record<string, unknown>>
  const policyVersion = frozen.policy.version
  const generatedAt = dateTimeLabel(new Date())
  const context: ReportContext = {
    reportNumber: frozen.reportNumber,
    revisionNumber: frozen.revision,
    fiscalYear: evidence.fiscalYear,
    finalizedAt: frozen.finalizedAt,
    policyVersion,
    generatedAt,
    warehouseName: revision.warehouseName,
  }

  // Page 1 — Vendor Information / Annual Activity Summary
  const firstPage = addReportPage(document, '', context, logo, regular, bold)
  const drawCentered = (value: string, baseline: number, font: PDFFont, size: number, color = INK) => {
    const textWidth = font.widthOfTextAtSize(value, size)
    firstPage.page.drawText(value, { x: (PAGE_WIDTH - textWidth) / 2, y: baseline, font, size, color })
  }
  drawCentered('รายงานผลการประเมินผู้ขายประจำปี', 751, bold, 15, BLUE)
  drawCentered('Annual Vendor Evaluation Report', 737, regular, 10, MUTED)
  drawCentered(`ปีงบประมาณ ${evidence.fiscalYear}`, 720, bold, 10)
  drawCentered(`${dateLabel(evidence.coverage.startDate)} – ${dateLabel(evidence.coverage.endDate)} · จัดทำเมื่อ ${generatedAt}`, 706, regular, 8.5, MUTED)
  firstPage.page.drawRectangle({ x: MARGIN_X, y: 677, width: CONTENT_WIDTH, height: 23, color: BLUE_SOFT })
  firstPage.page.drawText('1. ข้อมูลผู้ขาย / Vendor Information', { x: MARGIN_X + 8, y: 683, font: bold, size: 12.5, color: BLUE })
  const vendorRows = [
    ['รหัสผู้ขาย', text(vendor.vendorCode)],
    ['ชื่อผู้ขาย', text(vendor.name)],
    ['ชื่อตามหนังสือรับรอง', text(vendor.legalName)],
    ['เลขประจำตัวผู้เสียภาษี / สาขา', `${text(vendor.taxId)} / ${text(vendor.taxBranchCode)}`],
    ['ที่อยู่', text(vendor.address)],
    ['คลังที่ประเมิน', `${text(evidence.warehouse.name)} (${text(evidence.warehouse.code)})`],
    ['ผู้ติดต่อ / โทรศัพท์ / อีเมล', 'ไม่มีข้อมูลใน Snapshot ที่ตรึงไว้'],
  ]
  const vendorColumns: Column[] = [{ header: 'ข้อมูลผู้ขาย', width: 155 }, { header: 'รายละเอียด', width: CONTENT_WIDTH - 155 }]
  let state = drawPaginatedTable(document, { page: firstPage.page, y: 669 }, '1. ข้อมูลผู้ขาย / Vendor Information (ต่อ)', vendorColumns, vendorRows, context, logo, regular, bold, 'ไม่มีข้อมูลผู้ขายใน Snapshot')
  const totalReceipts = receipts.length
  const complaintCount = issues.filter((issue) => issue.issueType === 'complaint').length
  const activityRows = [
    ['จำนวน Invoice', numberLabel(activity.invoices)],
    ['เหตุการณ์รับของทั้งหมด', String(totalReceipts)],
    ['แบบประเมินเสร็จสมบูรณ์', numberLabel(activity.completedAssessments)],
    ['แบบประเมินรอดำเนินการ', numberLabel(activity.pendingAssessments)],
    ['ปัญหาที่เปิดอยู่ / แก้ไขแล้ว', `${numberLabel(activity.openIssues)} / ${numberLabel(activity.resolvedIssues)}`],
    ['ข้อร้องเรียน', String(complaintCount)],
  ]
  if (state.y < CONTENT_BOTTOM + 235) {
    state = addReportPage(document, '2. สรุปกิจกรรมประจำปี / Annual Activity Summary', context, logo, regular, bold)
  }
  const leftX = MARGIN_X
  const columnGap = 12
  const columnWidth = (CONTENT_WIDTH - columnGap) / 2
  const rightX = leftX + columnWidth + columnGap
  const panelTop = drawSubheadingAt(state.page, '2. สรุปกิจกรรมประจำปี', leftX, columnWidth, state.y - 16, bold)
  drawSubheadingAt(state.page, 'ผลการประเมินประจำปี', rightX, columnWidth, state.y - 16, bold)
  const activityBottom = drawInlineTable(state.page, leftX, panelTop, [
    { header: 'ตัวชี้วัด', width: columnWidth - 52 }, { header: 'จำนวน', width: 52, align: 'center' },
  ], activityRows, regular, bold, 8)
  // The result card needs room for the score, verdict, requirement line and donut even when the activity table is short.
  const resultBottom = Math.min(activityBottom, panelTop - 178)
  const panelHeight = panelTop - resultBottom
  state.page.drawRectangle({ x: rightX, y: resultBottom, width: columnWidth, height: panelHeight, color: frozen.result === 'pass' ? TEAL_SOFT : RED_SOFT, borderColor: frozen.result === 'pass' ? TEAL : RED, borderWidth: 0.8 })
  state.page.drawText(numberLabel(frozen.score), { x: rightX + 14, y: panelTop - 52, font: bold, size: 27, color: BLUE })
  state.page.drawText('/ 100', { x: rightX + 90, y: panelTop - 49, font: regular, size: 11, color: MUTED })
  const resultLabel = frozen.result === 'pass' ? 'ผ่าน' : 'ไม่ผ่าน'
  state.page.drawText(resultLabel, { x: rightX + 14, y: panelTop - 72, font: bold, size: 15, color: frozen.result === 'pass' ? TEAL : RED })
  const requirement = `เกณฑ์ผ่าน ${numberLabel(frozen.policy.passThreshold)} · ครอบคลุมขั้นต่ำ ${numberLabel(frozen.policy.minimumCoveragePercent)}%`
  state.page.drawText(requirement, { x: rightX + 14, y: panelTop - 88, font: regular, size: 7.8, color: MUTED })
  const coverageCompleted = numeric(evidence.coverage.completed) ?? 0
  const coveragePending = numeric(evidence.coverage.pending) ?? 0
  drawDonut(state.page, rightX + columnWidth / 2, resultBottom + 55, 25, coverageCompleted, coveragePending, bold, regular)
  state.page.drawText('ประเมินแล้ว / ทั้งหมด', { x: rightX + 12, y: resultBottom + 12, font: regular, size: 7.5, color: MUTED })
  state.y = Math.min(activityBottom, resultBottom) - 20
  state.y = drawSubheading(state.page, 'สรุปผู้บริหาร', state.y, bold)
  state = drawPaginatedText(document, { page: state.page, y: state.y }, '1. สรุปผู้บริหาร (ต่อ)', frozen.judgment.summary, context, logo, regular, bold)

  // Page 2 — Performance Evaluation
  const page2 = addReportPage(document, '3. ผลการประเมินตามเกณฑ์ / Performance Evaluation', context, logo, regular, bold)
  const performanceColumns: Column[] = [
    { header: 'ลำดับ', width: 32, align: 'center' }, { header: 'เกณฑ์การประเมิน', width: 153 },
    { header: 'หลักฐาน (ผล / ทั้งหมด)', width: 101, align: 'center' }, { header: 'ผล (%)', width: 62, align: 'right' },
    { header: 'น้ำหนัก (%)', width: 67, align: 'right' }, { header: 'คะแนนถ่วงน้ำหนัก', width: CONTENT_WIDTH - 415, align: 'right' },
  ]
  let page2State: PageState = { page: page2.page, y: drawSubheading(page2.page, 'ผลประเมินจากหลักฐานในรายงานที่ตรึงไว้', page2.y, bold) }
  const performanceRows = frozen.criteria.map((criterion) => [
    numberLabel(criterion.displayOrder), criterionLabel(criterion.criterionCode, criterion.label),
    numeric(criterion.denominator) === 0 ? 'N/A' : `${numberLabel(criterion.numerator)} / ${numberLabel(criterion.denominator)}`,
    numeric(criterion.percentage) === null ? 'N/A' : `${numberLabel(criterion.percentage)}%`,
    numeric(criterion.weight) === null ? 'N/A' : `${numberLabel(criterion.weight)}%`,
    numeric(criterion.weightedScore) === null ? 'N/A' : numberLabel(criterion.weightedScore),
  ])
  page2State = drawPaginatedTable(document, page2State, '3. ผลการประเมินตามเกณฑ์ (ต่อ)', performanceColumns, performanceRows, context, logo, regular, bold, 'ไม่มีเกณฑ์ใน Snapshot')
  page2State.y = drawSubheading(page2State.page, 'ผลรวมและวิธีอ่านคะแนน', page2State.y - 18, bold)
  page2State.page.drawText(`คะแนนรวม ${numberLabel(frozen.score)} / 100`, { x: MARGIN_X + 3, y: page2State.y, font: bold, size: 15, color: BLUE })
  page2State.y -= 21
  const coverageLabel = numberLabel(evidence.coverage.percentage)
  page2State.page.drawText(`เกณฑ์ผ่าน ${numberLabel(frozen.policy.passThreshold)} · นโยบาย ${policyVersion} · ความครอบคลุมจริง ${coverageLabel === 'N/A' ? 'N/A' : `${coverageLabel}%`}`, { x: MARGIN_X + 3, y: page2State.y, font: regular, size: 9.5, color: INK })
  page2State.y -= 14
  page2State.y = drawWrapped(page2State.page, 'เกณฑ์ที่ไม่มีหลักฐาน (N/A) และการปรับน้ำหนักเป็นไปตามนโยบายและ Snapshot ที่ตรึงไว้ คะแนนนี้เป็นผลจากรายงานฉบับ Final ที่ใช้นโยบายอนุมัติแล้ว', MARGIN_X + 3, page2State.y, CONTENT_WIDTH - 6, regular, 9, MUTED, 11) - 4

  // Page 3 — Assessment & Exception Summary
  const page3 = addReportPage(document, '4. สรุปผลการประเมินและข้อยกเว้น / Assessment & Exception Summary', context, logo, regular, bold)
  const completedCount = assessments.length
  const pendingCount = numeric(activity.pendingAssessments) ?? 0
  page3.page.drawText(`แบบประเมินทั้งหมด ${completedCount + pendingCount} · เสร็จสมบูรณ์ ${completedCount} · รอดำเนินการ ${pendingCount}`, { x: MARGIN_X + 2, y: page3.y, font: regular, size: 9, color: MUTED })
  const assessmentLeftX = MARGIN_X
  const assessmentGap = 12
  const assessmentColumnWidth = (CONTENT_WIDTH - assessmentGap) / 2
  const assessmentRightX = assessmentLeftX + assessmentColumnWidth + assessmentGap
  const sectionTop = page3.y - 17
  const assessmentColumns: Column[] = [
    { header: 'ประเด็น', width: 103 }, { header: 'ปกติ / ไม่มี', width: 52, align: 'center' },
    { header: 'ผิดปกติ / มี', width: 61, align: 'center' }, { header: 'รวม', width: assessmentColumnWidth - 216, align: 'center' },
  ]
  const assessmentRows = assessmentSummaryRows(assessments).map((row) => [row[0], row[1], row[2], row[4]])
  drawSubheadingAt(page3.page, '4.1 สรุปผลตอบแบบประเมิน', assessmentLeftX, assessmentColumnWidth, sectionTop, bold)
  const assessmentBottom = drawInlineTable(page3.page, assessmentLeftX, sectionTop - 20, assessmentColumns, assessmentRows, regular, bold, 8)
  const criteriaBottom = drawCriteriaBars(page3.page, frozen.criteria as Array<Record<string, unknown>>, sectionTop, regular, bold, assessmentRightX, assessmentColumnWidth)
  const findingRows = issues.map((issue) => {
    const resolution = issue.status === 'resolved' ? (ISSUE_RESOLUTION_LABELS[text(issue.resolutionAction, '')] ?? 'แก้ไขแล้ว') : 'อยู่ระหว่างดำเนินการ'
    return [
      dateLabel(issue.openedAt), text(issue.invoiceNumber), text(issue.eventNumber),
      ISSUE_TYPE_LABELS[text(issue.issueType)] ?? text(issue.issueType), `${resolution}${issue.resolutionNote ? ` · ${text(issue.resolutionNote)}` : ''}`,
    ]
  })
  const findingsColumns: Column[] = [
    { header: 'วันที่', width: 64 }, { header: 'Invoice', width: 78 }, { header: 'Receipt', width: 72 },
    { header: 'ประเด็น', width: 123 }, { header: 'การดำเนินการ / หมายเหตุ', width: CONTENT_WIDTH - 337 },
  ]
  const page3State = drawPaginatedTable(document, {
    page: page3.page,
    y: drawSubheading(page3.page, '4.3 รายการปัญหาและข้อร้องเรียนสำคัญ', Math.min(assessmentBottom, criteriaBottom) - 16, bold),
  }, '4.3 รายการปัญหาและข้อร้องเรียนสำคัญ (ต่อ)', findingsColumns, findingRows, context, logo, regular, bold, 'ไม่พบปัญหาหรือข้อร้องเรียนใน Snapshot')
  page3State.y = drawMonthlyChart(page3State.page, receipts, issues, page3State.y - 16, regular, bold)

  // Page 4 — Judgment / Recommendation / Signatures
  const page4 = addReportPage(document, '5. คำวินิจฉัยและข้อเสนอแนะ / Annual Judgment & Recommendation', context, logo, regular, bold)
  let page4State: PageState = { page: page4.page, y: drawSubheading(page4.page, '5.1 คำวินิจฉัย', page4.y, bold) }
  const signatureReserve = 184
  const addJudgmentContinuation = () => {
    const next = addReportPage(document, '5. คำวินิจฉัยและข้อเสนอแนะ (ต่อ)', context, logo, regular, bold)
    page4State = { page: next.page, y: drawSubheading(next.page, 'คำวินิจฉัยและข้อเสนอแนะ (ต่อ)', next.y, bold) }
  }
  const drawJudgmentPanel = (x: number, width: number, title: string, lines: string[], minimumHeight: number, continuation: boolean) => {
    let offset = 0
    while (offset < lines.length) {
      let availableHeight = page4State.y - CONTENT_BOTTOM - signatureReserve - 10
      if (availableHeight < 70) {
        addJudgmentContinuation()
        availableHeight = page4State.y - CONTENT_BOTTOM - signatureReserve - 10
      }
      const maxLines = Math.max(1, Math.floor((availableHeight - 39) / 11))
      const count = Math.min(lines.length - offset, maxLines)
      const chunk = lines.slice(offset, offset + count)
      const panelHeight = Math.min(availableHeight, Math.max(minimumHeight, 39 + count * 11))
      const top = page4State.y
      page4State.page.drawRectangle({ x, y: top - panelHeight, width, height: panelHeight, color: WHITE, borderColor: BORDER, borderWidth: 0.7 })
      page4State.page.drawRectangle({ x, y: top - 25, width, height: 25, color: BLUE_SOFT })
      page4State.page.drawText(`${title}${continuation || offset > 0 ? ' (ต่อ)' : ''}`, { x: x + 8, y: top - 17, font: bold, size: 9.5, color: BLUE })
      drawTextLines(page4State.page, chunk, x + 9, top - 39, regular, 9.5, INK, 11)
      page4State.y = top - panelHeight - 9
      offset += count
      if (offset < lines.length) {
        addJudgmentContinuation()
        continuation = true
      }
    }
  }
  const fullWidth = CONTENT_WIDTH
  drawJudgmentPanel(MARGIN_X, fullWidth, 'สรุปผล', wrapAll(frozen.judgment.summary, regular, 9.5, fullWidth - 18), 90, false)

  const halfGap = 12
  const halfWidth = (CONTENT_WIDTH - halfGap) / 2
  const strengthLines = wrapAll(frozen.judgment.strengths, regular, 9.3, halfWidth - 18)
  const riskLines = wrapAll(frozen.judgment.risksConcerns, regular, 9.3, halfWidth - 18)
  let pairOffset = 0
  while (pairOffset < Math.max(strengthLines.length, riskLines.length)) {
    const availableHeight = page4State.y - CONTENT_BOTTOM - signatureReserve - 10
    if (availableHeight < 70) addJudgmentContinuation()
    const refreshedHeight = page4State.y - CONTENT_BOTTOM - signatureReserve - 10
    const maxLines = Math.max(1, Math.floor((refreshedHeight - 39) / 10.5))
    const count = Math.min(Math.max(strengthLines.length, riskLines.length) - pairOffset, maxLines)
    const height = Math.min(refreshedHeight, Math.max(139, 39 + count * 10.5))
    const top = page4State.y
    const drawColumn = (x: number, title: string, lines: string[]) => {
      page4State.page.drawRectangle({ x, y: top - height, width: halfWidth, height, color: WHITE, borderColor: BORDER, borderWidth: 0.7 })
      page4State.page.drawRectangle({ x, y: top - 25, width: halfWidth, height: 25, color: BLUE_SOFT })
      page4State.page.drawText(`${title}${pairOffset > 0 ? ' (ต่อ)' : ''}`, { x: x + 8, y: top - 17, font: bold, size: 9.2, color: BLUE })
      drawTextLines(page4State.page, lines.slice(pairOffset, pairOffset + count), x + 8, top - 39, regular, 9.2, INK, 10.5)
    }
    drawColumn(MARGIN_X, 'จุดแข็ง', strengthLines)
    drawColumn(MARGIN_X + halfWidth + halfGap, 'ความเสี่ยง / ประเด็นติดตาม', riskLines)
    page4State.y = top - height - 9
    pairOffset += count
    if (pairOffset < Math.max(strengthLines.length, riskLines.length)) addJudgmentContinuation()
  }

  drawJudgmentPanel(MARGIN_X, fullWidth, 'ข้อเสนอแนะ / แผนติดตาม', wrapAll(frozen.judgment.recommendations, regular, 9.5, fullWidth - 18), 104, false)
  if (page4State.y - signatureReserve < CONTENT_BOTTOM) addJudgmentContinuation()
  page4State.y = drawSubheading(page4State.page, '6. ผู้ประเมิน / ผู้ทบทวน / ผู้อนุมัติ', page4State.y - 14, bold)
  page4State.page.drawText(`รายงานสิ้นสุดเมื่อ ${dateLabel(frozen.finalizedAt)} · Revision ${frozen.revision} · Policy ${policyVersion}`, { x: MARGIN_X + 2, y: page4State.y, font: regular, size: 8.5, color: MUTED })
  const signatureWidth = (CONTENT_WIDTH - 24) / 3
  const signatureCardTop = page4State.y - 13
  const signatureCardHeight = 137
  const signatureCardBottom = signatureCardTop - signatureCardHeight
  const signatureX = [MARGIN_X, MARGIN_X + signatureWidth + 12, MARGIN_X + (signatureWidth + 12) * 2]
  const signatories = [
    ['ผู้ประเมิน', frozen.signatories.evaluator, evaluatorSignature],
    ['ผู้ทบทวน', frozen.signatories.reviewer, reviewerSignature],
    ['ผู้อนุมัติ', frozen.signatories.approver, approverSignature],
  ] as const
  signatories.forEach(([role, signatory, image], index) => {
    page4State.page.drawRectangle({ x: signatureX[index], y: signatureCardBottom, width: signatureWidth, height: signatureCardHeight, color: WHITE, borderColor: BORDER, borderWidth: 0.7 })
    drawSignature(page4State.page, signatureX[index], signatureCardBottom + 35, signatureWidth, role, signatory.name, signatory.position, image, regular, bold)
  })

  // Page 5 — Appendix A: one row per receipt event, with its frozen assessment detail.
  const page5 = addReportPage(document, 'ภาคผนวก ก — รายละเอียดการรับและประเมิน / Appendix A', context, logo, regular, bold)
  const assessmentsByEvent = new Map(assessments.map((assessment) => [text(assessment.eventNumber), assessment]))
  const appendixRows = receipts.map((receipt, index) => {
    const eventNumber = text(receipt.eventNumber)
    const assessment = assessmentsByEvent.get(eventNumber)
    const status = assessment ? 'ประเมินแล้ว' : receipt.assessmentState === 'not_required' ? 'ไม่ต้องประเมิน' : receipt.assessmentState === 'pending' ? 'รอประเมิน' : text(receipt.assessmentState)
    const answerDetails = assessment ? [
      `${ASSESSMENT_LABELS.productCondition}: ${answer(assessment.productCondition)}`,
      `${ASSESSMENT_LABELS.documentation}: ${answer(assessment.documentation)}`,
      `${ASSESSMENT_LABELS.itemCorrectness}: ${answer(assessment.itemCorrectness)}`,
      `${ASSESSMENT_LABELS.coldChainCondition}: ${assessment.coldChainApplicable === false ? 'N/A' : answer(assessment.coldChainCondition)}`,
      `${ASSESSMENT_LABELS.hasComplaint}: ${assessment.hasComplaint === true ? 'มี' : assessment.hasComplaint === false ? 'ไม่มี' : 'N/A'}`,
      `ผล: ${assessment.acceptanceDecision === 'accepted' ? 'รับสินค้า' : assessment.acceptanceDecision === 'accepted_with_justification' ? 'รับแบบมีเงื่อนไข' : 'รอประเมิน'}`,
      ...exceptionLabels(assessment),
    ].join(' · ') : 'ไม่มีแบบประเมินใน Snapshot'
    return [
      String(index + 1), text(receipt.invoiceNumber), text(receipt.poNumber), dateLabel(receipt.receivedDate), eventNumber, status,
      answerDetails, text(assessment?.note),
    ]
  })
  const appendixColumns: Column[] = [
    { header: 'ลำดับ', width: 34, align: 'center' }, { header: 'Invoice', width: 62 }, { header: 'PO', width: 50 }, { header: 'วันที่รับ', width: 62 },
    { header: 'Receipt', width: 67 }, { header: 'การประเมิน', width: 62 },
    { header: 'ผลประเมิน / ข้อยกเว้น', width: 127 }, { header: 'หมายเหตุ', width: CONTENT_WIDTH - 464 },
  ]
  const page5State: PageState = { page: page5.page, y: drawSubheading(page5.page, 'รายการรับแต่ละครั้งและแบบประเมินที่เกี่ยวข้อง (รับบางส่วนแยกรายเหตุการณ์)', page5.y, bold) }
  const appendixResult = drawPaginatedTable(document, page5State, 'ภาคผนวก ก — รายละเอียดการรับและประเมิน (ต่อ)', appendixColumns, appendixRows, context, logo, regular, bold, 'ไม่มีเหตุการณ์รับของใน Snapshot ที่ตรึงไว้')
  const appendixNoteState = appendixResult.y < CONTENT_BOTTOM + 28
    ? addReportPage(document, 'ภาคผนวก ก — รายละเอียดการรับและประเมิน (ต่อ)', context, logo, regular, bold)
    : appendixResult
  drawWrapped(
    appendixNoteState.page,
    'ใบรับที่ไม่ต้องประเมิน (ก่อนเริ่มใช้ระบบตรวจรับ) ไม่นับในคะแนน · จำนวนรายการต่อเหตุการณ์รับและชื่อผู้ประเมิน: N/A — ไม่มีข้อมูลดังกล่าวใน Snapshot ที่ตรึงไว้',
    MARGIN_X + 2, appendixNoteState.y - 12, CONTENT_WIDTH - 4, regular, 8.5, MUTED, 10,
  )

  // Page 6 — Appendix B: policy-frozen criteria reference.
  const page6 = addReportPage(document, 'ภาคผนวก ข — นิยามและเกณฑ์ประเมิน / Appendix B', context, logo, regular, bold)
  const referenceColumns: Column[] = [
    { header: 'ลำดับ', width: 34, align: 'center' }, { header: 'เกณฑ์', width: 103 },
    { header: 'นิยาม / แหล่งหลักฐาน', width: 126 }, { header: 'น้ำหนัก (%)', width: 62, align: 'right' },
    { header: 'วิธีคำนวณ', width: 119 }, { header: 'กรณี N/A', width: CONTENT_WIDTH - 444 },
  ]
  const referenceRows = frozen.criteria.map((criterion) => [
    numberLabel(criterion.displayOrder), criterionLabel(criterion.criterionCode, criterion.label),
    text(criterion.evidenceDefinition), numeric(criterion.weight) === null ? 'N/A' : `${numberLabel(criterion.weight)}%`,
    text(criterion.calculationDefinition), text(criterion.naDefinition),
  ])
  const page6State: PageState = { page: page6.page, y: drawSubheading(page6.page, `นิยามตามนโยบาย ${policyVersion} ที่ตรึงพร้อมรายงาน`, page6.y, bold) }
  drawPaginatedTable(document, page6State, 'ภาคผนวก ข — นิยามและเกณฑ์ประเมิน (ต่อ)', referenceColumns, referenceRows, context, logo, regular, bold, 'ไม่มีเกณฑ์อ้างอิงใน Snapshot')

  const pages = document.getPages()
  pages.forEach((page, index) => {
    page.drawLine({ start: { x: MARGIN_X, y: 37 }, end: { x: PAGE_WIDTH - MARGIN_X, y: 37 }, color: BORDER, thickness: 0.6 })
    page.drawText(`รายงานประเมินผู้ขาย · ปีงบประมาณ ${context.fiscalYear} · ${context.reportNumber} · Revision ${context.revisionNumber}`, { x: MARGIN_X, y: 21, font: regular, size: 7.5, color: MUTED })
    const pageLabel = `หน้า ${index + 1} / ${pages.length}`
    page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN_X - regular.widthOfTextAtSize(pageLabel, 8), y: 21, font: regular, size: 8, color: MUTED })
  })
  document.setTitle(`รายงานผลการประเมินผู้ขาย ${context.reportNumber}`)
  document.setSubject(`ผลประเมินผู้ขายประจำปี ${context.fiscalYear} · ${context.warehouseName}`)
  document.setCreator('CHEM-IMMUNO CBH')
  document.setProducer('CHEM-IMMUNO CBH')
  return document.save()
}
