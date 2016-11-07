#!/bin/sh
zip -r -u S3ToLoggly.zip S3ToLoggly.js node_modules
aws lambda update-function-code --function-name S3ToLoggly --zip-file fileb://S3ToLoggly.zip