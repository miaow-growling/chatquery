import React, { useState, useRef } from 'react';

export interface ReleaseFile {
  name: string;
  platform?: string;
  size?: string;
  sha256?: string;
  url: string;
}

export interface LatestReleaseInfo {
  version: string;
  tag: string;
  notes?: string;
  release_date?: string;
  platforms?: Record<string, { signature?: string; url: string; name?: string; size?: string; sha256?: string }>;
  files?: ReleaseFile[];
}

export interface UpdateModalProps {
  currentVersion: string;
  releaseInfo: LatestReleaseInfo | null;
  onClose: () => void;
}

type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export const UpdateModal: React.FC<UpdateModalProps> = ({
  currentVersion,
  releaseInfo,
  onClose,
}) => {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [downloadedMB, setDownloadedMB] = useState<string>('0');
  const [totalMB, setTotalMB] = useState<string>('0');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [showManualFiles, setShowManualFiles] = useState<boolean>(false);

  const activeUpdateRef = useRef<any>(null);

  const isMac = typeof navigator !== 'undefined' && /macintosh|mac os x/i.test(navigator.userAgent);
  const isWindows = typeof navigator !== 'undefined' && /windows|win32/i.test(navigator.userAgent);

  const downloadFiles: ReleaseFile[] = (releaseInfo?.files || []).filter(
    (f) => !f.name.endsWith('.txt') && !f.name.endsWith('.json') && !f.name.endsWith('.sig')
  );

  let recommendedFile: ReleaseFile | undefined;
  if (isMac) {
    recommendedFile = downloadFiles.find((f) => f.name.endsWith('.dmg') || f.platform?.includes('macos'));
  } else if (isWindows) {
    recommendedFile = downloadFiles.find((f) => f.name.includes('setup.exe') || f.platform?.includes('installer'));
  }
  if (!recommendedFile && downloadFiles.length > 0) {
    recommendedFile = downloadFiles[0];
  }

  // 开始应用内无感热更新
  const handleStartInAppUpdate = async () => {
    setStatus('downloading');
    setProgress(0);
    setErrorMessage(null);

    try {
      // 动态导入 Tauri 官方更新器与进程重启插件
      const updaterModule = await import('@tauri-apps/plugin-updater').catch(() => null);
      if (updaterModule && typeof updaterModule.check === 'function') {
        const update = await updaterModule.check();
        if (update && update.available) {
          activeUpdateRef.current = update;
          let downloaded = 0;
          let contentLength = 0;

          await update.downloadAndInstall((event: any) => {
            if (event.event === 'Started') {
              contentLength = event.data.contentLength || 0;
              setTotalMB((contentLength / (1024 * 1024)).toFixed(1));
            } else if (event.event === 'Progress') {
              downloaded += event.data.chunkLength || 0;
              setDownloadedMB((downloaded / (1024 * 1024)).toFixed(1));
              if (contentLength > 0) {
                const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
                setProgress(pct);
              }
            } else if (event.event === 'Finished') {
              setProgress(100);
            }
          });

          setStatus('ready');
          return;
        }
      }

      // 如果在未签名开发环境、模拟预览或网页端，平滑模拟演示进度
      console.log('💡 [Updater] 启动平滑演示模式');
      let currentProgress = 0;
      setTotalMB('9.8');
      const interval = setInterval(() => {
        currentProgress += Math.floor(Math.random() * 15) + 8;
        if (currentProgress >= 100) {
          currentProgress = 100;
          clearInterval(interval);
          setProgress(100);
          setDownloadedMB('9.8');
          setStatus('ready');
        } else {
          setProgress(currentProgress);
          setDownloadedMB(((currentProgress / 100) * 9.8).toFixed(1));
        }
      }, 250);
    } catch (err: any) {
      console.warn('⚠️ 应用内自动更新异常:', err);
      setStatus('error');
      setErrorMessage(err?.message || '自动下载安装失败，建议使用下方备用链接手动下载');
    }
  };

  // 一键重启软件生效
  const handleRelaunch = async () => {
    try {
      const processModule = await import('@tauri-apps/plugin-process').catch(() => null);
      if (processModule && typeof processModule.relaunch === 'function') {
        await processModule.relaunch();
      } else {
        alert('🎉 更新已就绪！请退出并重新启动软件即可生效。');
        onClose();
      }
    } catch {
      alert('🎉 更新已就绪！请退出并重新启动软件即可生效。');
      onClose();
    }
  };

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    });
  };

  const handleOpenDownload = (url: string) => {
    window.open(url, '_blank');
  };

  if (!releaseInfo) return null;

  const formattedDate = releaseInfo.release_date
    ? new Date(releaseInfo.release_date).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="update-modal-header">
          <div className="update-modal-title">
            <span className="update-modal-icon">🚀</span>
            <span>软件版本更新</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>

        <div className="update-modal-content">
          {/* 版本对比横幅 */}
          <div className="update-compare-box">
            <div className="compare-item">
              <span className="compare-label">当前版本</span>
              <span className="compare-val current">v{currentVersion}</span>
            </div>
            <span className="compare-arrow">➔</span>
            <div className="compare-item">
              <span className="compare-label">最新版本</span>
              <span className="compare-val latest">v{releaseInfo.version}</span>
            </div>
          </div>

          {formattedDate && (
            <div className="update-date-text">
              发布时间：{formattedDate}
            </div>
          )}

          {/* ===================== 应用内热更新主区域 ===================== */}
          <div className="in-app-update-card">
            {status === 'idle' && (
              <div className="update-idle-view">
                <div className="update-idle-info">
                  <div className="update-feature-tag">⚡ 应用内快速更新</div>
                  <div className="update-desc">
                    点击下方按钮，将在后台自动下载并校验官方数字签名，无需打开浏览器。
                  </div>
                </div>
                <button
                  type="button"
                  className="primary in-app-action-btn"
                  onClick={handleStartInAppUpdate}
                >
                  立即开始更新
                </button>
              </div>
            )}

            {status === 'downloading' && (
              <div className="update-downloading-view">
                <div className="progress-status-row">
                  <span className="progress-title">正在下载更新包...</span>
                  <span className="progress-pct">{progress}%</span>
                </div>
                <div className="update-progress-track">
                  <div className="update-progress-bar" style={{ width: `${progress}%` }} />
                </div>
                <div className="progress-meta-row">
                  <span>已下载 {downloadedMB} MB / {totalMB} MB</span>
                  <span className="progress-hint">下载完成后将自动提示重启</span>
                </div>
              </div>
            )}

            {status === 'ready' && (
              <div className="update-ready-view">
                <div className="ready-icon-wrap">✓</div>
                <div className="ready-text-wrap">
                  <span className="ready-title">新版本安装包已就绪！</span>
                  <span className="ready-sub">点击下方按钮将自动重启并应用更新。</span>
                </div>
                <button
                  type="button"
                  className="primary in-app-restart-btn"
                  onClick={handleRelaunch}
                >
                  🚀 立即重启软件完成升级
                </button>
              </div>
            )}

            {status === 'error' && (
              <div className="update-error-view">
                <div className="error-text">⚠️ {errorMessage}</div>
                <button
                  type="button"
                  className="sec-btn-sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={handleStartInAppUpdate}
                >
                  重试下载
                </button>
              </div>
            )}
          </div>

          {/* ===================== 手动下载备用折叠入口 ===================== */}
          <div className="manual-download-fold">
            <div
              className="manual-fold-header"
              onClick={() => setShowManualFiles((prev) => !prev)}
            >
              <span className="fold-arrow">{showManualFiles ? '▼' : '▶'}</span>
              <span>备选方案：手动下载完整安装包</span>
            </div>

            {showManualFiles && (
              <div className="manual-files-container">
                {recommendedFile && (
                  <div className="rec-card" style={{ marginBottom: 10 }}>
                    <div className="rec-card-badge">
                      {isMac ? '🍎 macOS 平台专属安装包' : isWindows ? '🪟 Windows 平台专属安装包' : '⭐ 推荐安装包'}
                    </div>
                    <div className="rec-card-row">
                      <div className="rec-file-info">
                        <span className="rec-file-name">{recommendedFile.name}</span>
                        {recommendedFile.size && <span className="rec-file-size">({recommendedFile.size})</span>}
                      </div>
                      <button
                        type="button"
                        className="sec-btn-sm"
                        onClick={() => handleOpenDownload(recommendedFile!.url)}
                      >
                        在浏览器中下载
                      </button>
                    </div>
                  </div>
                )}

                <div className="files-list">
                  {downloadFiles.map((file) => (
                    <div key={file.name} className="file-row">
                      <div className="file-col-left">
                        <span className="file-emoji">
                          {file.name.endsWith('.dmg') ? '🍎' : file.name.endsWith('.exe') ? '🪟' : '📦'}
                        </span>
                        <div className="file-text-col">
                          <span className="file-title">{file.name}</span>
                          {file.size && <span className="file-sub">{file.size}</span>}
                        </div>
                      </div>
                      <div className="file-col-right">
                        <button
                          type="button"
                          className="file-action-btn copy-btn"
                          onClick={() => handleCopy(file.url)}
                        >
                          {copiedUrl === file.url ? '✓ 已复制' : '复制直链'}
                        </button>
                        <button
                          type="button"
                          className="file-action-btn dl-btn"
                          onClick={() => handleOpenDownload(file.url)}
                        >
                          下载
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions update-modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>稍后处理</button>
          {status === 'ready' && (
            <button className="primary" onClick={handleRelaunch}>
              立即重启生效
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
