/*
 * LD_PRELOAD shim for selkies-desktop: list ~/Desktop in name order.
 *
 * selkies-desktop draws one icon per .desktop file in $HOME/Desktop, in
 * whatever order readdir() returns them, which depends on the filesystem
 * (creation order, hash order, or reversed on tmpfs). wadspaces-layout names
 * the launchers it seeds 01-..., 02-..., so sorting by name gives the order the
 * wadspace was designed with in the Builder.
 *
 * Only directories whose path ends in "/Desktop" are sorted; everything else
 * goes straight to libc. Built by images/base/Dockerfile into
 * /usr/local/lib/wadspaces/libsorted-desktop.so and used by labwc-autostart.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

struct sorted_dir {
    DIR *dir;
    struct dirent **ents;
    size_t n, next;
    struct sorted_dir *link;
};

static struct sorted_dir *open_dirs;
static DIR *(*real_opendir)(const char *);
static struct dirent *(*real_readdir)(DIR *);
static int (*real_closedir)(DIR *);

static void resolve(void) {
    if (!real_opendir) real_opendir = dlsym(RTLD_NEXT, "opendir");
    if (!real_readdir) real_readdir = dlsym(RTLD_NEXT, "readdir");
    if (!real_closedir) real_closedir = dlsym(RTLD_NEXT, "closedir");
}

static int by_name(const void *a, const void *b) {
    return strcmp((*(struct dirent *const *)a)->d_name, (*(struct dirent *const *)b)->d_name);
}

static int is_desktop_dir(const char *path) {
    size_t len = strlen(path);
    while (len > 1 && path[len - 1] == '/') len--;
    return len >= 8 && strncmp(path + len - 8, "/Desktop", 8) == 0;
}

DIR *opendir(const char *name) {
    resolve();
    DIR *d = real_opendir(name);
    if (!d || !is_desktop_dir(name)) return d;

    struct sorted_dir *s = calloc(1, sizeof *s);
    if (!s) return d;
    size_t cap = 0;
    struct dirent *e;
    while ((e = real_readdir(d)) != NULL) {
        if (s->n == cap) {
            cap = cap ? cap * 2 : 32;
            struct dirent **grown = realloc(s->ents, cap * sizeof *grown);
            if (!grown) break;
            s->ents = grown;
        }
        struct dirent *copy = malloc(sizeof *copy);
        if (!copy) break;
        memcpy(copy, e, sizeof *copy);
        s->ents[s->n++] = copy;
    }
    qsort(s->ents, s->n, sizeof *s->ents, by_name);
    s->dir = d;
    s->link = open_dirs;
    open_dirs = s;
    return d;
}

struct dirent *readdir(DIR *d) {
    resolve();
    for (struct sorted_dir *s = open_dirs; s; s = s->link) {
        if (s->dir == d) return s->next < s->n ? s->ents[s->next++] : NULL;
    }
    return real_readdir(d);
}

int closedir(DIR *d) {
    resolve();
    for (struct sorted_dir **p = &open_dirs; *p; p = &(*p)->link) {
        if ((*p)->dir == d) {
            struct sorted_dir *s = *p;
            *p = s->link;
            for (size_t i = 0; i < s->n; i++) free(s->ents[i]);
            free(s->ents);
            free(s);
            break;
        }
    }
    return real_closedir(d);
}
