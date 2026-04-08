module.exports = (sequelize, DataTypes) => {
  const Organisation = sequelize.define(
    'Organisation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false,
      },
      plan: {
        type: DataTypes.ENUM('trial', 'standard', 'starter', 'growth', 'enterprise'),
        defaultValue: 'trial',
      },
      trial_ends_at: DataTypes.DATE,
      timezone: {
        type: DataTypes.STRING,
        defaultValue: 'Asia/Kolkata',
      },
      settings: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
    },
    {
      tableName: 'organisations',
      timestamps: true,
      paranoid: true,
      underscored: true,
    }
  );

  Organisation.associate = (models) => {
    Organisation.hasMany(models.Branch, {
      foreignKey: 'org_id',
      as: 'branches',
    });
    Organisation.hasMany(models.Department, {
      foreignKey: 'org_id',
      as: 'departments',
    });
    Organisation.hasMany(models.Shift, {
      foreignKey: 'org_id',
      as: 'shifts',
    });
    Organisation.hasMany(models.Employee, {
      foreignKey: 'org_id',
      as: 'employees',
    });
  };

  return Organisation;
};
