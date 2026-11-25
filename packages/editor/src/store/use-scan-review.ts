import { create } from 'zustand'

/**
 * Hand-off between the scan evidence panel and a host's review view. The host registers the view
 * that reviews a proposed outline (`registerScanReviewView`); the panel asks for a scan to be
 * reviewed there. The panel offers the action only while a host has registered one.
 */
type ScanReviewState = {
  /** The host view that reviews scans, or null when the host has none. */
  viewId: string | null
  /** The scan the person asked to review; the view clears it once it has taken it up. */
  requestedScanId: string | null
  request: (scanId: string) => void
  clear: () => void
}

export const useScanReview = create<ScanReviewState>((set) => ({
  viewId: null,
  requestedScanId: null,
  request: (scanId) => set({ requestedScanId: scanId }),
  clear: () => set({ requestedScanId: null }),
}))

export function registerScanReviewView(viewId: string): void {
  useScanReview.setState({ viewId })
}
