import React, { useState } from 'react';

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
  release_date?: string;
  platforms?: Record<string, ReleaseFile>;
  files?: ReleaseFile[];
}

export interface UpdateModalProps {
  currentVersion: string;
  releaseInfo: LatestReleaseInfo | null;
  onClose: () => void;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  currentVersion,
  releaseInfo,
  onClose,
}) => {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  if (!releaseInfo) return null;

  const isMac = typeof navigator !== 'undefined' && /macintosh|mac os x/i.test(navigator.userAgent);
  const isWindows = typeof navigator !== 'undefined' && /windows|win32/i.test(navigator.userAgent);

  // 整理所有安装包文件（排除校验文件和 json 清单）
  const downloadFiles: ReleaseFile[] = (releaseInfo.files || []).filter(
    (f) => !f.name.endsWith('.txt') && !f.name.endsWith('.json')
  );

  // 推荐当前平台的首选文件
  let recommendedFile: ReleaseFile | undefined;
  if (isMac) {
    recommendedFile = downloadFiles.find((f) => f.name.endsWith('.dmg') || f.platform?.includes('macos'));
  } else if (isWindows) {
    recommendedFile = downloadFiles.find((f) => f.name.includes('setup.exe') || f.platform?.includes('installer'));
  }

  if (!recommendedFile && downloadFiles.length > 0) {
    recommendedFile = downloadFiles[0];
  }

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    });
  };

  const handleOpenDownload = (url: string) => {
    window.open(url, '_blank');
  };

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

          {/* 针对当前操作系统的首选推荐安装包 */}
          {recommendedFile && (
            <div className="rec-card">
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
                  className="primary rec-download-btn"
                  onClick={() => handleOpenDownload(recommendedFile!.url)}
                >
                  立即下载安装包
                </button>
              </div>
            </div>
          )}

          {/* 全平台所有下载地址 */}
          <div className="downloads-section">
            <div className="section-label">全平台安装包下载直链：</div>
            <div className="files-list">
              {downloadFiles.length > 0 ? (
                downloadFiles.map((file) => (
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
                ))
              ) : (
                <div className="empty-files-text">暂未发现可下载的安装包</div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-actions update-modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
          {recommendedFile && (
            <button className="primary" onClick={() => handleOpenDownload(recommendedFile!.url)}>
              在浏览器中打开下载
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
