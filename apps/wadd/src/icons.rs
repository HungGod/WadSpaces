//! Web apps' icons, made before an image builds (wad-icons): the site's own
//! icon as a silhouette card, the user's picture, or a card with the site's
//! name. WadSpaces Client asks for them as a design gets its web apps (prefetch),
//! so they're in the cache (`<state_dir>/webapp-icons`) by the time it builds;
//! a build waits for what's missing, but not for long: past its budget, a
//! web app gets the card with its name.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{StreamExt, stream};
use tokio::time::Instant;
use wad_icons::{Icon, Resolver, Source, cache::Cache, label_for, png, style};
use wad_proto::v1::{IconKind, IconSource};

/// A build waits this long for all its icons together.
const BUILD_BUDGET: Duration = Duration::from_secs(20);
const AT_ONCE: usize = 6;

/// One web app's icon, for a build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IconJob {
    /// The app id (wadspaces-webapp-<id>).
    pub id: String,
    pub site: String,
    pub custom: Option<String>,
}

/// How a build's icons were made.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Made {
    pub site: usize,
    pub custom: usize,
    pub fallback: usize,
}

pub struct Icons {
    resolver: Resolver,
}

impl Icons {
    pub fn new(dir: &std::path::Path) -> Arc<Self> {
        Arc::new(Self { resolver: Resolver::new(Some(Cache::new(dir))) })
    }

    /// Without a cache, asking sites on this network too (tests).
    pub fn for_tests() -> Arc<Self> {
        Arc::new(Self { resolver: Resolver::new(None).allow_local() })
    }

    pub async fn icon(&self, site: &str, custom: Option<&str>) -> Icon {
        self.resolver.icon(site, custom).await
    }

    /// Makes `apps`' icons in the background (into the cache).
    pub fn prefetch(self: &Arc<Self>, apps: Vec<IconSource>) {
        let me = self.clone();
        tokio::spawn(async move {
            stream::iter(apps)
                .for_each_concurrent(AT_ONCE, |a| {
                    let me = me.clone();
                    async move {
                        me.icon(&a.site, a.custom.as_deref()).await;
                    }
                })
                .await;
        });
    }

    /// A build's icons, by app id, within the build's budget.
    pub async fn for_build(&self, jobs: &[IconJob]) -> (Vec<(String, Vec<u8>)>, Made) {
        let deadline = Instant::now() + BUILD_BUDGET;
        let made: Vec<(String, Icon)> = stream::iter(jobs.iter().cloned())
            .map(|j| async move {
                let icon = match tokio::time::timeout_at(deadline, self.icon(&j.site, j.custom.as_deref())).await {
                    Ok(icon) => icon,
                    Err(_) => {
                        tracing::info!(site = %j.site, "no icon in time: its name instead");
                        Icon { png: png(&style::text_card(&label_for(&j.site))), source: Source::Fallback }
                    }
                };
                (j.id, icon)
            })
            .buffer_unordered(AT_ONCE)
            .collect()
            .await;
        let mut counts = Made::default();
        let icons = made
            .into_iter()
            .map(|(id, icon)| {
                match icon.source {
                    Source::Site => counts.site += 1,
                    Source::Custom => counts.custom += 1,
                    Source::Fallback => counts.fallback += 1,
                }
                (id, icon.png)
            })
            .collect();
        (icons, counts)
    }
}

pub fn kind(source: Source) -> IconKind {
    match source {
        Source::Site => IconKind::Site,
        Source::Custom => IconKind::Custom,
        Source::Fallback => IconKind::Fallback,
    }
}
