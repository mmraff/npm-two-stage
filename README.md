# npm-two-stage
#### Code for dividing `npm install` into download and offline-install stages

_________________________

## Who This Code Is For
Any node.js developer or configuration manager who has reason to install
Javascript modules for node.js on a system that is not connected to the
Internet. Some use cases:
- The security policy of an organization requires that the development/usage
 environment is disconnected from the Internet
- A student needs to work with node modules usually installable by npm, but
 there is no Internet connection available to the target system

## What This Is Not
This project is not an entire fork of npm.
## What It Is
It's only a set of new files and modified versions of a few of npm's
existing files. They are intended to be superimposed on an existing
npm installation.
_________________________

## Introduction
**npm** is a Javascript package manager and much more. You get it automatically
with a proper installation of the cross-platform JavaScript runtime environment
**[node.js](http://nodejs.org/download/)**.
 
[This link is to the official documentation of npm](https://docs.npmjs.com/).  

When used to install a package, the default behavior of npm is to fetch the
package and all of its dependencies from one or more remote servers, typically
the **[npm registry](https://docs.npmjs.com/misc/registry)**, and to install
to the current platform. This works fine for all users except those in use
cases such as described previously.  

With **npm-two-stage** installed over a portable npm installation on a USB
drive, for example, one simply uses
<span style="display:inline-block;">`npm download`</span> to collect the
desired packages and all their dependencies into a folder on the USB drive.
Then the USB drive is taken to the target system which also has npm-two-stage
installed, and one runs the offline install command line (see below).  
_Note that your npm installations modified by npm-two-stage will behave exactly
the same as unmodified npm if you don't use the `--offline` option._
_________________________

## Before Proceeding
Check that your **npm** installation is one of the versions targeted by
this project.<br>
**You are currently viewing the version that targets npm 7.24.0.**

## To Install
### If an Internet connection is *not* available for the target platform:
Refer to the [Manual Installation Instructions](docs/MANUAL-INSTALL.md).  

### If the target platform *can* be connected to the Internet:
First install the npm registry package **@offliner/npm2stage-v7.24.0**, a
command line tool made to manage installation and removal of this version
of npm-two-stage.
Once installed, it will provide the command `npm2stage install`.
Use of that *might* require elevated privileges, depending on the target
npm location.

## To Uninstall
The installation management tool named above also provides the command
`npm2stage uninstall`.

## Updates - Caution
This code is not published to a registry, because it is not a self-contained
package.
The strategy used in the installation management package mentioned above,
which names this repo as a dependency, is to specify the branch name in the
git spec (instead of a commit hash or a commit tag). This causes npm to fetch
the HEAD of the named branch on first installation, and that is exactly what
is intended, because occasionally there may be need for a patch. This also
helps avoid versioning complications.
However, `npm install` resolves what is fetched to a specific commit, and
that is what will be written to package-lock.json; so a naive attempt to
update npm-two-stage will either get the same version instead of the patched
one, or it will fail with a git error, unless the following steps are taken:
1. Execute the command `npm2stage uninstall`
2. Use **npm** to uninstall **@offliner/npm2stage-v7.24.0**.
3. Clear the cache: `npm cache clear --force`
4. Use **npm** to re-install **@offliner/npm2stage-v7.24.0**.
5. Execute `npm2stage install`

After that, your applied npm-two-stage code will be current.

## Before Other Changes To Your npm Installation
* Note that backup copies of the original files modified by the installation
 manager are created in the same location. If you ever want to uninstall
 npm-two-stage with the installation manager, and you want to avoid
 complications, you will get best results if you don't touch the backup files.
* If you want to update npm or update your node.js installation, you must
 do that before installing this. If you have already installed npm-two-stage,
 you should first run the `uninstall` command of the installation manager.
_________________________

## Usage
<a id="src1"></a>Where `PACKAGE_SPEC` can have [almost any form<sup>1</sup>](#fn1)
that is valid to npm in an install context...

### Download Stage
```
npm download PACKAGE_SPEC
```
**-or-**
```
npm download PACKAGE_SPEC --dl-dir path/to/put/tarballs
```
will fetch the version of the package that best matches the specifier, plus
all non-development packages in its dependency tree, as gzipped tar archives,
with no redundant downloads.
* Shorthand `dl` may be substituted for `download`.
* Without the `--dl-dir` option, downloads will go to the current directory.
* Any number of package specifiers can be given on a single command line.
* Most version ranges must be put in quotes so that your shell will not
 misinterpret any special characters in the specifier
 (e.g. `<`, `>`, `-`).

#### package-json Option
Alternatively (or additionally), the option `--package-json`, followed
by the path of a directory that contains a package.json file, may be given to
tell `npm download` to fetch the dependencies listed there.
* devDependencies are omitted unless the option `--include=dev` is given.
* `--pj` is a convenient abbreviation for `--package-json`.
* `-J` is equivalent to `--package-json` with no path given, where the
package.json is expected to be in the current directory.

```
npm download --package-json ../path/to/packageJson/dir
```
will fetch the non-development dependencies listed in the package.json found
at the given path (and all transitive dependencies), saving them to the
current directory.
```
npm download -J --dl-dir ../path/to/put/tarballs
```
will fetch the non-development dependencies listed in the package.json found
in the current directory (and all transitive dependencies), saving them to
the given path.
* While `--package-json` must be followed by a path argument, `-J` does not
 take any argument.

#### lockfile-dir Option
Alternatively (or additionally), the option `--lockfile-dir` followed by the
path of a directory that contains a lockfile (npm-shrinkwrap.json,
package-lock.json, or yarn.lock), may be given to tell `npm download` to
fetch the dependencies listed there.
* devDependencies are omitted unless the option `--include=dev` is given.
* If the lockfile is a yarn.lock, only version 1 is supported.
* If the lockfile is a yarn.lock, it *must* be accompanied by a matching
 package.json file.
```
npm download --lockfile-dir ../path/that/contains
```
will fetch the non-development dependencies listed in the lockfile found at
the given path, saving them to the current directory.

The command line examples given above will fetch regular, peer, and optional
dependencies, and packaged lockfiles will be honored.
Options are available for changing how dependencies are fetched:
```
  --include=<dev|optional|peer>
  --omit=<dev|optional|peer>
  --only=prod[uction]       ***deprecated***
  --also=dev[elopment]      ***deprecated***
```

A file named dltracker.json will be created in the same directory where the
downloads are saved. This file contains metadata that will be used in the
next stage, and so it must travel with the package files.  

If `npm download` is used again to target the same directory, the new metadata
is merged into the dltracker.json file. This can be done any number of times.  

### Installation Stage
```
npm install --offline --offline-dir path/to/find/tarballs PACKAGE_SPEC
```
The arrangement of arguments can be any that is valid for unmodified npm,
but the `--offline` switch and the path for `--offline-dir` (to the tarball
directory) must be given.

#### `npm install` without a spec:
If `PACKAGE_SPEC` is omitted, it will do the reasonable thing: look for a
package.json and lockfile in the current directory, and try to install the
dependencies listed there. If a lockfile is present, that will drive the
installation; otherwise the package.json will be the authority.

_________________________
## Footnotes
<a id="fn1" href="#src1"><sup>1</sup></a> File and directory package specs
 are meaningless in the download context, of course.

        
_________________________

License: MIT

