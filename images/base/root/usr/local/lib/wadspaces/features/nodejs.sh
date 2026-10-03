# Node.js LTS from NodeSource (Debian's own npm pulls in hundreds of node-* debs).
# The Selkies base image already ships the NodeSource 22 source; only add one
# when it is missing, otherwise apt refuses two Signed-By values for one URI.
NODE_MAJOR="${NODE_MAJOR:-22}"
if ! grep -rqs deb.nodesource.com /etc/apt/sources.list.d/; then
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt_repo_added
fi
apt_install nodejs
node --version
