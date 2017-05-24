#!/bin/bash

# WARNING: The files referenced in this script are specific to npm 2.x

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

CHANGED_FILES="cache install npm"
ADDED_FILES="download git-offline offliner"
ADDED_DIRS="download"

trap "echo Failed to execute a filesystem command - aborting uninstall; exit -4" ERR
for f in $CHANGED_FILES
do
  if [ -f "$TARGET_DIR"/${f}_ORIG.js ]
  then
    echo "  Moving ${f}_ORIG.js to ${f}.js in target location..."
    mv -fT "$TARGET_DIR"/${f}_ORIG.js "$TARGET_DIR"/${f}.js
  else
    echo "  WARNING: Backup of ${f}.js not found in target directory"
  fi
done

for f in $ADDED_FILES
do
  if [ -f "$TARGET_DIR"/${f}.js ]
  then
    echo "  Removing ${f}.js from target location..."
    rm "$TARGET_DIR"/${f}.js
  fi
done

for f in $ADDED_DIRS
do
  if [ -d "$TARGET_DIR"/${f} ]
  then
    echo "  Removing ${f} from target location..."
    rm -r "$TARGET_DIR"/$f
  fi
done

echo ""
echo "  Uninstallation of npm-two-stage was successful."
echo ""

