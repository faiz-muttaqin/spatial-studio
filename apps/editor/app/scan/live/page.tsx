import { LiveView } from './live-view'

/**
 * The small page the companion shows over its camera view while scanning (P2N.3). It draws a coverage map
 * and a live outline from the stream; it is only useful inside the companion app, and does not touch the
 * scan itself.
 */
export default function LiveScanPage() {
  return <LiveView />
}
