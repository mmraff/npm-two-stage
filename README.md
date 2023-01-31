# npm-two-stage
#### Code for dividing `npm install` into download and offline-install stages

_________________________

## Who This Code Is For
Any node.js developer or configuration manager who has reason to install
node modules on a system that is not connected to the Internet. Some use cases:
- The security policy of an organization requires that the development/usage
 environment is disconnected from the Internet (some call this _Air-Gapped_)
- A student needs to work with node modules usually installable by npm, but
 there is no Internet connection available to the target system

## What This Is Not
This repository is not an entire fork of npm; it's only a set of new files and
modified versions of a few existing files. They are intended to be superimposed
on an existing npm installation.
_________________________

## Introduction
**npm** is a Javascript package manager and much more. You get it automatically
with a proper installation of the server-side JavaScript engine
**[node.js](http://nodejs.org/download/)**.  
[The official documentation of npm is here](https://docs.npmjs.com/).  
When used to install a package, the default behavior of npm is to fetch the
package and all of its dependencies from one or more remote servers, typically
the **[npm registry](https://docs.npmjs.com/misc/registry)**, and to install to
the current platform. This works fine for all users except, e.g., those in the
use cases above.  

Theoretically, one could manually install some kinds of packages and their trees
of dependencies by repeating this sequence however many times needed:
```sh
mkdir node_modules && cd node_modules
tar xzf path/to/module-name-version.tar.gz
mv package module-name && cd module-name
```
but for a non-trivial package heirarchy, not only would that be impractical,
it also would not work for every kind of package.  

With **npm-two-stage** installed over (say) a portable npm installation on a USB
drive, you simply have `npm download` collect the desired packages and all their
dependencies into a folder on the USB drive. Then you take the USB drive to the
target system which also has npm-two-stage installed, and run the offline install
command line (see below).  
_Note that your npm installations modified by npm-two-stage will behave exactly
the same as unmodified npm if you don't use the `--offline` option._
_________________________

### Before Attempting Installation or Removal
*Rewrite in progress*

## To Install
*Rewrite in progress*

## To Uninstall
**Only use the same version of this project as was used for installation.**

*Rewrite in progress*
_________________________

## Usage
<a id="src1"></a>Where `PACKAGE_SPEC` can have [almost any form<sup>1</sup>](#fn1 "Aliases are not yet supported in `npm download`. File and directory package specs are meaningless in this context, of course.") that is valid to npm in an install context...

### Download Stage
```sh
npm download PACKAGE_SPEC
```
**-or-**
```sh
npm download PACKAGE_SPEC --dl-dir=path/to/put/tarballs
```
will fetch the version of the package that best matches the specification, plus
all the packages in its dependency tree, as gzipped tar archives, with no
redundant downloads.  
* Shorthand `dl` may be substituted for `download`.  
* Any number of package specifiers can be given on a single command line.  
* Without the `--dl-dir` option, downloads will go to the current directory.  

Alternatively (or additionally), the option `--package-json`, optionally followed
by the path of a directory that contains a package.json file, may be given to
tell `npm download` to refer to the dependencies listed there. If a path is not
specified, the current directory is assumed.
* `--pj` is a convenient abbreviation for `--package-json`.
* `-J` is equivalent to `--package-json` with no path given, where the
package.json is expected to be in the current directory.  

```sh
npm download --package-json=../path/to/packageJson/dir
```
will fetch the dependencies listed in the package.json found at the given path
(and all transitive dependencies), saving them to the current directory.
```sh
npm download -J --dl-dir=../path/to/put/tarballs
```
will fetch the dependencies listed in the package.json found in the current
directory (and all transitive dependencies), saving them to the given path.

Note that the `=` is required for the `--dl-dir` option, and for the
`--package-json` | `--pj` option when supplying a path.  

The command lines examples given above will fetch regular and optional dependencies,
and shrinkwraps will be honored.
Options are available for changing how dependencies are fetched:
```sh
  --include=<dev|optional|peer>
  --omit=<dev|optional|peer>
  --only=prod[uction]       ***deprecated***
  --also=dev[elopment]      ***deprecated***
```

A file named dltracker.json will be created in the same directory as the
downloads. This file contains metadata that will be used in the next stage, and
so it must travel with the package files.  

If `npm download` is used again to target the same directory, the new metadata
is merged into the dltracker.json file. This can be done any number of times.  

### Installation Stage
```sh
npm install --offline --offline-dir=path/to/find/tarballs PACKAGE_SPEC
```

Note that the `=` is required for the `--offline-dir` option.  
If `PACKAGE_SPEC` is omitted, will do the reasonable thing: look for
package.json in the current directory, and try to install the dependencies
listed there.

_________________________
## Footnotes
<a id="fn1" href="#src1"><sup>1</sup></a> Aliases are not yet supported in `npm download`. File and directory package specs are meaningless in this context, of course.

`npm download --help` will show the supported forms as follows:
```sh
  npm download [<@scope>/]<pkg>
  npm download [<@scope>/]<pkg>@<tag>
  npm download [<@scope>/]<pkg>@<version>
  npm download [<@scope>/]<pkg>@<version range>
  npm download <github username>/<github project>
  npm download <git-host>:<git-user>/<repo-name>
  npm download <git:// url>
  npm download <tarball url>
```        

        
_________________________

License: MIT

