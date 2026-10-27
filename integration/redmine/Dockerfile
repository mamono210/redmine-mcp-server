FROM ruby:3.4.5-bookworm@sha256:7a61aa7fe86768830f65d8e12571fc115f381a54557c7c88619a5368b92a0474

ENV RAILS_ENV=production \
    BUNDLE_WITHOUT=development:test:ldap:minimagick
WORKDIR /redmine

RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential libpq-dev libyaml-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN git init . \
    && git fetch --depth 1 https://github.com/redmine/redmine.git f7ea71f9563ea7b346a8dbc7abb3854fc69321ea \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = f7ea71f9563ea7b346a8dbc7abb3854fc69321ea \
    && git rev-parse HEAD > /opt/redmine-source-commit \
    && rm -rf .git

LABEL org.opencontainers.image.revision="f7ea71f9563ea7b346a8dbc7abb3854fc69321ea"
COPY database.yml config/database.yml
COPY Gemfile.local Gemfile.local
RUN bundle install --jobs 4 --retry 3
COPY seed.rb /opt/integration/seed.rb
COPY entrypoint.sh /opt/integration/entrypoint.sh
RUN chmod 755 /opt/integration/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/opt/integration/entrypoint.sh"]
