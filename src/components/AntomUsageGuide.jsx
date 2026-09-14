/** @jsx jsx */
import { jsx } from '@emotion/core';
import Button from '@material-ui/core/Button';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';

/** Local help stays available without opening an external documentation site. */
const AntomUsageGuide = ({ open, onClose }) => (
  <Dialog open={open} onClose={onClose} aria-labelledby="antom-usage-guide-title" fullWidth maxWidth="sm"
    PaperProps={{ style: { margin: 16, width: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)' } }}>
    <DialogTitle id="antom-usage-guide-title">Usage guide</DialogTitle>
    <DialogContent dividers css={{ fontSize: '13px', lineHeight: 1.5, overflowWrap: 'anywhere', '& p': { margin: '0 0 14px' }, '& p:last-child': { marginBottom: 0 } }}>
      <p><strong>Setup in Builder.</strong> Select Skills and review payment settings, then paste the setup request in the current Builder Agent chat. GitHub mode asks the Agent to import complete files and merge non-secret configuration into .env.example. Bill-only setup leaves payment configuration untouched.</p>
      <p><strong>GitHub (no npm).</strong> The plugin checks published source hashes. The Agent must use permitted native web and file tools, stop on denied access, truncated content or file conflicts, and never run install commands or change ACL settings. Source verification is not destination verification: read back the written files and report any checks that could not be completed. Copying a request does not install Skills.</p>
      <p><strong>Start a new chat.</strong> After setup checks pass, open a new Builder chat and paste an example for your selected Skill.</p>
      <p><strong>Server Secrets.</strong> Add API Keys and merchant private keys in your server environment or secret manager. Never put them in plugin settings, exported files, or Agent chat.</p>
      <p><strong>Notify uses RSA.</strong> All notify-related interfaces use RSA, including in API Key mode. Configure the Antom public key and required RSA references.</p>
      <p><strong>Legacy installers.</strong> Public npm requires the exact published package. Project test package requires matching files in tools/antom-builder and owner-approved verification and setup commands. Both need Node.js 20+. If a command is denied, stop; do not change permissions or reroute it. These are separate options, not automatic fallbacks from GitHub.</p>
      <p><strong>Bill analysis.</strong> Supply sanitized bills only. Python and separate dependencies are required. Online reports and live transaction queries need separate authorization; --live is independent of the plugin environment. Public knowledge may be fetched online.</p>
    </DialogContent>
    <DialogActions>
      <Button type="button" onClick={onClose} color="primary" style={{ textTransform: 'none' }}>Done</Button>
    </DialogActions>
  </Dialog>
);

export default AntomUsageGuide;
