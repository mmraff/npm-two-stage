#!/bin/bash

# WARNING: The files referenced in this script are specific to npm 7.x

if [ ! -f ./target-ver.txt ]
then
  echo "ERROR: Missing target version file!"
  exit 1
fi

NPM_VER=`npm --version`
if [ "$?" -ne 0 -o X"$NPM_VER" = X ]
then
  echo "ERROR: Could not get information from npm --version!"
  exit -1
fi

EXPECTED_NPM_VER=$(cat ./target-ver.txt)
if [ "$EXPECTED_NPM_VER" != "$NPM_VER" ]
then
  echo "ERROR: Wrong version of npm"
  exit -2
fi

NPM_ROOT=`npm root -g`
TARGET_DIR="$NPM_ROOT/npm/lib"
echo ""
echo "  Target directory is $NPM_ROOT/npm/lib"
echo ""
if [ ! -d $TARGET_DIR ]
then
  echo "ERROR: Invalid layout at supposed npm installation location"
  exit -3
fi

CHANGED_FILES="install utils/cmd-list utils/config/definitions"
ADDED_FILES="download"
ADDED_DIRS="download offliner"

trap "echo Failed to execute a filesystem command - aborting installation; exit -4" ERR
for f in $CHANGED_FILES
do
  echo "  Renaming ${f}.js to ${f}_ORIG.js in target location..."
  mv -fT "$TARGET_DIR"/${f}.js "$TARGET_DIR"/${f}_ORIG.js
  echo "  Copying src/${f}.js into target location..."
  cp src/${f}.js "$TARGET_DIR"/${f}.js
done

for f in $ADDED_FILES
do
  echo "  Copying src/${f}.js into target location..."
  cp src/${f}.js "$TARGET_DIR"/${f}.js
done

for f in $ADDED_DIRS
do
  echo "  Copying src/${f} into target location..."
  cp -r src/${f} "$TARGET_DIR"/${f}
  echo "  Fixing permissions on src/${f}..."
  chmod a+rx "$TARGET_DIR"/${f}
done

echo ""
echo "  Installation of npm-two-stage was successful."
echo ""

