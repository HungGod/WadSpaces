# Runtime + packager prerequisites for KaleBrowser. The browser itself is
# installed by `wadspaces-kalebrowser-install` after the workspace's
# resources file has been copied in.
need nodejs
need electron-deps
apt_install python3 python3-venv libcairo2
