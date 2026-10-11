import { useEffect, useState } from 'react';
import type { AdapterInstallState } from '../shared/contracts';
import { adapterInstallAnnouncement, adapterInstallText } from './adapter-install-view';

export function AdapterInstallProgress({
  install,
  className,
  fallback,
}: {
  install?: AdapterInstallState;
  className?: string;
  fallback?: string;
}) {
  const [now, setNow] = useState(Date.now);
  const [hadInstall, setHadInstall] = useState(Boolean(install));
  if (install && !hadInstall) setHadInstall(true);
  const startedAt = install?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const text = install ? adapterInstallText(install, now) : fallback;
  return (
    <>
      {text && <span className={className}>{text}</span>}
      <span className="visually-hidden" role="status">
        {install || hadInstall ? adapterInstallAnnouncement(install) : ''}
      </span>
    </>
  );
}
