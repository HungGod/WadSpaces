# OpenShot from Debian (linuxserver's docker-openshot uses the project's PPA
# on Ubuntu instead), with that image's fix for two copies of qt_api.
apt_install openshot-qt
QT_API=/usr/lib/python3/dist-packages/openshot_qt/qt_api.py
[[ -f "${QT_API}" ]] && ln -sf "${QT_API}" /usr/lib/python3/dist-packages/qt_api.py
add_desktop_entry openshot org.openshot.OpenShot.desktop
