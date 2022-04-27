#!/usr/bin/bash
#nyc mocha ./test/00[12]*.js
#nyc --nycrc-path=./test/config/003_nycrc.json mocha ./test/003*.js
#nyc --nycrc-path=./test/config/004_nycrc.json mocha ./test/004*.js
nyc --nycrc-path=./test/config/005_nycrc.json mocha ./test/005*.js
#nyc --nycrc-path=./test/config/010_nycrc.json mocha ./test/010*.js
#nyc --nycrc-path=./test/config/020_nycrc.json mocha ./test/020*.js
