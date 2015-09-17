var async = require('async');
var _ = require('lodash');
var request = require('request');
var settings = require('./settings.json');

var j = request.jar();
var cookie = request.cookie('_splitwise_session=' + settings.splitwiseSession);
j.setCookie(cookie, 'https://secure.splitwise.com/');

var postToSlack = function(payload, done) {
    return request({
        method: 'post',
        url: settings.slack.webhookUrl,
        json: payload
    }, function(err, resp, body) {
        return done(err, body);
    });
};

return async.auto({
    expenses: function(next) {
        return request({
            url: 'https://secure.splitwise.com/api/v3.0/get_expenses',
            jar: j,
            json: true
        }, function(err, resp, body) {
            return next(err, body);
        });
    },
    group: function(next) {
        return request({
            url: 'https://secure.splitwise.com/api/v3.0/get_groups',
            jar: j,
            json: true
        }, function(err, resp, body) {
            return next(err, body);
        });
    },
    formatPayload: ['expenses', 'group', function(next, args) {
        var out = _.chain(args.expenses.expenses)
            .sortBy('-created_at')
            .map(function(expense) {
                var creator = expense.created_by.first_name + ' ' + expense.created_by
                    .last_name;
                var description = creator + ' added a receipt for ' + expense.description;
                var payload = {
                    channel: settings.slack.channel,
                    text: '*'+description+'*',
                    attachments: [{
                        fallback: description,
                        color: '#D00000',
                        fields: _.chain(expense.users)
                            .map(function (user) {
                                return {
                                    title: user.user.first_name + ' ' + user.user.last_name,
                                    value: (parseFloat(user.paid_share) > 0.0) ?
                                        ('Paid ' + user.paid_share + ' and is owed ' + user.net_balance) :
                                        ('Owes ' + user.owed_share),
                                    short: true
                                };
                            })
                            .value()
                    }]
                };

                if (expense.details) {
                    payload.attachments.unshift({
                        fallback: 'Details',
                        color: '#00D000',
                        fields: _.map(expense.details.split('\n\r'), function (detail) {
                            return {
                                title: 'Detail',
                                value: detail,
                                short: false
                            };
                        })
                    });
                }

                return payload;
            })
            .first()
            .value();

        return next(null, out);
    }],
    sendToSlack: ['formatPayload', function(next, args) {
        return postToSlack(args.formatPayload, next);
    }]
}, function(err, data) {
    if (err) {
        console.warn('Error!', err, err.message);
        return;
    }

    console.log('payload sent: ' + JSON.stringify(data.formatPayload, null, 2));

    return;
});
