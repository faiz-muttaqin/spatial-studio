import packageJson from '../../package.json'
import { ScanApp } from './scan-app'

/**
 * Phone entry point for room capture. It sits outside `(studio)`, so it ships
 * none of the editor, viewer or plugin code; the proxy gates it like every
 * other page.
 */
export default function ScanPage() {
  return <ScanApp appVersion={packageJson.version} />
}
