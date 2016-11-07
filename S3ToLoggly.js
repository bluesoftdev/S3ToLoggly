//AWS Lambda Script to send S3 logs to Loggly

var aws = require('aws-sdk')
var s3 = new aws.S3({apiVersion: '2006-03-01'})
var zlib = require('zlib')
var csv = require('fast-csv')
var _ = require('lodash')
, async = require('async')
, request = require('request')
, Transform = require('stream').Transform
, moment = require('moment')

// Set the tag 'loggly-customer-token'to set Loggly customer token on the S3 bucket.
// Set the tag 'loggly-tag' to set Loggly tag on the S3 bucket.

LOGGLY_URL_BASE = 'https://logs-01.loggly.com/inputs/'
BUCKET_LOGGLY_TOKEN_NAME = 'loggly-customer-token'
BUCKET_LOGGLY_TAG_NAME = 'loggly-tag'

// This REGEX is applied to the key and if it matches, the domain name, from the prefix, 
// will be added as a tag to the log data.
DOMAIN_TAG_REGEX = /^logs\/(.*)\/.*$/

// Used if no S3 bucket tag doesn't contain customer token.
// Note: You either need to specify a cutomer token in this script or via the S3 bucket tag else an error is logged.
DEFAULT_LOGGLY_URL = null

if ( typeof LOGGLY_TOKEN !== 'undefined' ) { 
    DEFAULT_LOGGLY_URL = LOGGLY_URL_BASE + LOGGLY_TOKEN;

    if ( typeof LOGGLY_TAG !== 'undefined' ) {
        DEFAULT_LOGGLY_URL += '/tag/' + LOGGLY_TAG;
    }
}

if ( DEFAULT_LOGGLY_URL ) {
    console.log('Loading S3ToLoggly, default Loggly endpoint: ' + DEFAULT_LOGGLY_URL);
}
else {
    console.log('Loading S3ToLoggly, NO default Loggly endpoint, must be set in bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME );
}

/**
 * Extract file contents.
 * @param buffer
 * @param callback
 * @returns {*} Buffer data - archive contents.
 */
function gunzip(buffer, callback) {
    zlib.gunzip(buffer, callback);
}

var csvCFParserConfig = {
        comment: "#",
        delimiter: '\t',
        headers: [
            'date',
            'time',
            'x-edge-location',
            'sc-bytes',
            'c-ip',
            'cs-method',
            'cs(Host)',
            'cs-uri-stem',
            'sc-status',
            'cs(Referer)',
            'cs(User-Agent)',
            'cs-uri-query',
            'cs(Cookie)',
            'x-edge-result-type',
            'x-edge-request-id',
            'x-host-header',
            'cs-protocol',
            'cs-bytes',
            'time-taken',
            'x-forwarded-for',
            'ssl-protocol',
            'ssl-cipher',
            'x-edge-response-result-type',
            'cs-protocol-version'
        ]
    }
var csvS3ParserConfig = {
    delimiter: ' ',
    headers: [
      'bucket-owner-id',
      'bucket',
      'timestamp',
      'time-zone',
      'requestor-ip',
      'requestor-id',
      'request-id',
      'operation',
      'key',
      'request-uri',
      'http-status',
      'error-code',
      'bytes-sent',
      'object-size',
      'total-time-ms',
      'turn-around-time-ms',
      'referrer',
      'user-agent',
      'version-id'
    ]
}
function replaceDashesWithNulls(data) {
    for(var key in data) {
        if (data.hasOwnProperty(key)) {
            if (data[key] === '-') {
                data[key] = null
            }
        }
    }
    return data
}
var transformS3 = function(data) {
    data = replaceDashesWithNulls(data)
    // parse the time and timezone parts and convert to one date
    var timeParts = data['timestamp'].substring(1)
    var timeZone = data['time-zone'].substring(0,data['time-zone'].length - 1)
    var timeStr = timeParts + ' ' + timeZone
    data['timestamp'] = moment(timeStr,'DD/MMM/YYYY:HH:mm:ss Z').format()
    data['time-zone'] = null
    if (data['http-status']) data['http-status'] = parseInt(data['http-status'],10);
    if (data['bytes-sent']) data['bytes-sent'] = parseInt(data['bytes-sent'],10);
    if (data['object-size']) data['object-size'] = parseInt(data['object-size'],10);
    if (data['total-time-ms']) data['total-time-ms'] = parseInt(data['total-time-ms'],10);
    if (data['turn-around-time-ms']) data['turn-around-time-ms'] = parseInt(data['turn-around-time-ms'],10);
    return data
}
var transformCF = function(data) {
    data = replaceDashesWithNulls(data)
    // Convert some fields to integer.
    data["time-taken"] = parseInt(data["time-taken"], 10);
    data["cs-bytes"] = parseInt(data["cs-bytes"], 10);
    data["sc-bytes"] = parseInt(data["sc-bytes"], 10);
    if (data['cs(User-Agent)']) data['cs(User-Agent)'] = decodeURI(decodeURI(data['cs(User-Agent)']))
    if (data['time'] && data['date']) {
        data['timestamp'] = data['date']+'T'+data['time']
        delete data['time']
        delete data['date']
    }
    return data;
}
exports.handler = function(event, context) {

    // console.log('Received event');
    // Get the object from the event and show its content type
    var bucket = event.Records[0].s3.bucket.name;
    var key  = event.Records[0].s3.object.key;
    var size = event.Records[0].s3.object.size;
    var domainTag = key.match(DOMAIN_TAG_REGEX)

    if ( size == 0 ) {
        console.log('S3ToLoggly skipping object of size zero')
    } 
    else {
        // Download the logfile from S3, and upload to loggly.
        async.waterfall([
            function buckettags(next) {
                var params = {
                    Bucket: bucket /* required */
                };

                s3.getBucketTagging(params, function(err, data) {
                    if (err) { 
                        next(err); console.log(err, err.stack); 
                    } // an error occurred
                    else {
                        var s3tag = _.zipObject(_.pluck(data['TagSet'], 'Key'),
                        _.pluck(data['TagSet'], 'Value'));

                        if (s3tag[BUCKET_LOGGLY_TOKEN_NAME]) {
                            LOGGLY_URL = LOGGLY_URL_BASE + s3tag[BUCKET_LOGGLY_TOKEN_NAME];
                            
                            if ( s3tag[BUCKET_LOGGLY_TAG_NAME] ) {
                                LOGGLY_URL += '/tag/' + s3tag[BUCKET_LOGGLY_TAG_NAME];
                                if (domainTag) {
                                    LOGGLY_URL += ',' + domainTag[1]
                                }
                            } else if (domainTag) {
                                LOGGLY_URL += '/tag/' + domainTag[1]
                            }
                        } 
                        else {
                            LOGGLY_URL = DEFAULT_LOGGLY_URL
                        }
                    }
                    
                    if ( LOGGLY_URL ) next();
                    else next('No Loggly customer token. Set S3 bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME)
                });
            },

            function download(next) {
                // Download the image from S3 into a buffer.
                s3.getObject({
                    Bucket: bucket,
                    Key: key
                }, next);
            },

            function gunzipStep(data, next) {
                if (key.match(/^.*\.gz$/)) {
                  gunzip(data.Body,next)
                } else {
                  next(null,data.Body)
                }
            },

            function upload(data, next) {
                // Stream the logfile to loggly.
                var bufferStream = new Transform();
                bufferStream.push(data)
                bufferStream.end()
                //console.log( 'Using Loggly endpoint: ' + LOGGLY_URL )
                var csvParser = csv(csvS3ParserConfig)
                var transform = transformS3
                if (key.match(/^.*\.gz$/)) {
                    csvParser = csv(csvCFParserConfig)
                    transform = transformCF
                }

                csvParser.transform(function(data,next) {
                    data = transform(data)
                    request.post({
                        url: LOGGLY_URL,
                        json: true,
                        body: data
                    }, function(error,response,body) {
                        if (error) {
                            console.log("[-] Unable to post log record:");
                            console.log(error);
                            next(error,response);
                        } else {
                            next(null,response);
                        }
                    });
                }).on('data',function(data){
                }).on('error',function(error) {
                    console.log('[-] processed error : '+error)
                }).on('end',function() {
                    next(null)
                })
                bufferStream.pipe(csvParser)
            }
        ], 
        function (err) {
            if (err) {
                console.error(
                'Unable to read ' + bucket + '/' + key +
                ' and upload to loggly' +
                ' due to an error: ' + err
                );
            } else {
                console.log(
                'Successfully uploaded ' + bucket + '/' + key +
                ' to ' + LOGGLY_URL
                );
            }
            context.done();
        });
    }
};
